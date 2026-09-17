const { query, withTransaction } = require('../config/db');
const { logAudit } = require('./AuditService');

/**
 * Get cashier pass allocations with event, category, and cashier details
 */
async function getAllocations({
  eventId = null,
  cashierId = null,
  categoryId = null,
  search = '',
  page = 1,
  limit = 20
} = {}) {
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const pageLimit = Math.min(100, Math.max(5, parseInt(limit, 10) || 20));
  const offset = (pageNum - 1) * pageLimit;

  const whereConditions = [];
  const queryParams = [];

  if (eventId) {
    whereConditions.push('ca.event_id = ?');
    queryParams.push(parseInt(eventId, 10));
  }

  if (cashierId) {
    whereConditions.push('ca.cashier_id = ?');
    queryParams.push(parseInt(cashierId, 10));
  }

  if (categoryId) {
    whereConditions.push('ca.category_id = ?');
    queryParams.push(parseInt(categoryId, 10));
  }

  if (search && search.trim()) {
    whereConditions.push('(u.name LIKE ? OR u.email LIKE ? OR pc.name LIKE ? OR e.event_name LIKE ?)');
    const searchTerm = `%${search.trim()}%`;
    queryParams.push(searchTerm, searchTerm, searchTerm, searchTerm);
  }

  const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

  const [countResult] = await query(
    `SELECT COUNT(*) as total
     FROM cashier_allocations ca
     JOIN users u ON ca.cashier_id = u.id
     JOIN pass_categories pc ON ca.category_id = pc.id
     JOIN events e ON ca.event_id = e.id
     ${whereClause}`,
    queryParams
  );
  const totalRecords = countResult ? countResult.total : 0;
  const totalPages = Math.ceil(totalRecords / pageLimit);

  const allocations = await query(
    `SELECT ca.*,
            (ca.allocated_quantity - ca.sold_quantity) as remaining_quantity,
            u.name as cashier_name, u.email as cashier_email,
            pc.name as category_name, pc.code as category_code, pc.price as category_price, pc.min_selling_price,
            e.event_name, e.event_code,
            cu.name as created_by_name
     FROM cashier_allocations ca
     JOIN users u ON ca.cashier_id = u.id
     JOIN pass_categories pc ON ca.category_id = pc.id
     JOIN events e ON ca.event_id = e.id
     LEFT JOIN users cu ON ca.created_by = cu.id
     ${whereClause}
     ORDER BY ca.updated_at DESC, ca.id DESC
     LIMIT ? OFFSET ?`,
    [...queryParams, pageLimit, offset]
  );

  return {
    allocations: allocations.map(a => ({
      id: a.id,
      eventId: a.event_id,
      eventName: a.event_name,
      eventCode: a.event_code,
      categoryId: a.category_id,
      categoryName: a.category_name,
      categoryCode: a.category_code,
      basePrice: parseFloat(a.category_price || 0),
      minSellingPrice: parseFloat(a.min_selling_price || 0),
      cashierId: a.cashier_id,
      cashierName: a.cashier_name,
      cashierEmail: a.cashier_email,
      allocatedQuantity: a.allocated_quantity,
      soldQuantity: a.sold_quantity,
      remainingQuantity: Math.max(0, a.allocated_quantity - a.sold_quantity),
      utilizationRate: a.allocated_quantity > 0 ? Math.round((a.sold_quantity / a.allocated_quantity) * 100) : 0,
      createdByName: a.created_by_name,
      createdAt: a.created_at,
      updatedAt: a.updated_at
    })),
    pagination: {
      page: pageNum,
      limit: pageLimit,
      totalRecords,
      totalPages
    }
  };
}

/**
 * Create or set a cashier allocation
 */
async function createAllocation({
  eventId,
  categoryId,
  cashierId,
  quantity,
  userId = null,
  userName = 'Admin',
  ipAddress = null,
  userAgent = null
}) {
  const qty = parseInt(quantity, 10);
  if (!eventId || !categoryId || !cashierId || isNaN(qty) || qty <= 0) {
    throw new Error('Valid event, category, cashier, and positive quantity are required');
  }

  // Validate event, category, cashier
  const eventRows = await query('SELECT id, event_name FROM events WHERE id = ?', [eventId]);
  if (!eventRows || eventRows.length === 0) throw new Error('Event not found');

  const catRows = await query('SELECT id, name, event_id, total_quantity FROM pass_categories WHERE id = ?', [categoryId]);
  if (!catRows || catRows.length === 0) throw new Error('Category not found');
  if (catRows[0].event_id !== parseInt(eventId, 10)) {
    throw new Error('Category does not belong to the specified event');
  }

  const cashierRows = await query('SELECT id, name, role_id, event_id FROM users WHERE id = ?', [cashierId]);
  if (!cashierRows || cashierRows.length === 0) throw new Error('Cashier user not found');
  if (cashierRows[0].event_id && cashierRows[0].event_id !== parseInt(eventId, 10)) {
    throw new Error('Cashier is assigned to a different event');
  }

  const result = await withTransaction(async (conn) => {
    // Check if allocation already exists
    const [existing] = await conn.query(
      'SELECT id, allocated_quantity, sold_quantity FROM cashier_allocations WHERE event_id = ? AND category_id = ? AND cashier_id = ? FOR UPDATE',
      [eventId, categoryId, cashierId]
    );

    let allocationId;
    if (existing.length > 0) {
      // Add quantity to existing allocation
      allocationId = existing[0].id;
      const newTotal = existing[0].allocated_quantity + qty;
      await conn.query(
        'UPDATE cashier_allocations SET allocated_quantity = ?, updated_at = NOW() WHERE id = ?',
        [newTotal, allocationId]
      );
    } else {
      const [insertRes] = await conn.query(
        `INSERT INTO cashier_allocations (event_id, category_id, cashier_id, allocated_quantity, sold_quantity, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, ?, NOW(), NOW())`,
        [eventId, categoryId, cashierId, qty, userId]
      );
      allocationId = insertRes.insertId;
    }

    await logAudit({
      userId,
      userName,
      action: 'ALLOCATE_PASSES',
      entity: 'CASHIER_ALLOCATION',
      entityId: allocationId,
      newValue: {
        eventId,
        categoryId,
        categoryName: catRows[0].name,
        cashierId,
        cashierName: cashierRows[0].name,
        allocatedQuantity: qty
      },
      ipAddress,
      userAgent
    });

    return { allocationId };
  });

  return result;
}

/**
 * Update/adjust allocation quantity directly (cannot be set lower than already sold quantity)
 */
async function updateAllocationQuantity({
  allocationId,
  newQuantity,
  userId = null,
  userName = 'Admin',
  ipAddress = null,
  userAgent = null
}) {
  const targetQty = parseInt(newQuantity, 10);
  if (isNaN(targetQty) || targetQty < 0) {
    throw new Error('Allocation quantity must be a non-negative number');
  }

  return await withTransaction(async (conn) => {
    const [allocRows] = await conn.query(
      'SELECT * FROM cashier_allocations WHERE id = ? FOR UPDATE',
      [allocationId]
    );

    if (!allocRows || allocRows.length === 0) {
      throw new Error('Allocation record not found');
    }

    const alloc = allocRows[0];
    if (targetQty < alloc.sold_quantity) {
      throw new Error(`Allocated quantity cannot be reduced below already sold quantity (${alloc.sold_quantity})`);
    }

    await conn.query(
      'UPDATE cashier_allocations SET allocated_quantity = ?, updated_at = NOW() WHERE id = ?',
      [targetQty, allocationId]
    );

    await logAudit({
      userId,
      userName,
      action: 'UPDATE_ALLOCATION_QUANTITY',
      entity: 'CASHIER_ALLOCATION',
      entityId: allocationId,
      oldValue: { allocatedQuantity: alloc.allocated_quantity },
      newValue: { allocatedQuantity: targetQty, soldQuantity: alloc.sold_quantity },
      ipAddress,
      userAgent
    });

    return {
      success: true,
      allocationId,
      allocatedQuantity: targetQty,
      soldQuantity: alloc.sold_quantity,
      remainingQuantity: targetQty - alloc.sold_quantity
    };
  });
}

/**
 * Get allocations assigned strictly to the logged-in Cashier
 */
async function getMyAllocations(cashierId, eventId = null) {
  const whereConditions = ['ca.cashier_id = ?'];
  const queryParams = [parseInt(cashierId, 10)];

  if (eventId) {
    whereConditions.push('ca.event_id = ?');
    queryParams.push(parseInt(eventId, 10));
  }

  const rows = await query(
    `SELECT ca.*,
            (ca.allocated_quantity - ca.sold_quantity) as remaining_quantity,
            pc.name as category_name, pc.code as category_code, pc.price as category_price,
            pc.min_selling_price, pc.category_prefix,
            e.event_name, e.event_code, e.status as event_status
     FROM cashier_allocations ca
     JOIN pass_categories pc ON ca.category_id = pc.id
     JOIN events e ON ca.event_id = e.id
     WHERE ${whereConditions.join(' AND ')}
     ORDER BY ca.updated_at DESC, ca.id DESC`,
    queryParams
  );

  return rows.map(r => ({
    id: r.id,
    eventId: r.event_id,
    eventName: r.event_name,
    eventCode: r.event_code,
    eventStatus: r.event_status,
    categoryId: r.category_id,
    categoryName: r.category_name,
    categoryCode: r.category_code,
    categoryPrefix: r.category_prefix || '',
    basePrice: parseFloat(r.category_price || 0),
    minSellingPrice: parseFloat(r.min_selling_price || 0),
    effectiveMinPrice: parseFloat(r.min_selling_price || 0) > 0 ? parseFloat(r.min_selling_price) : parseFloat(r.category_price || 0),
    allocatedQuantity: r.allocated_quantity,
    soldQuantity: r.sold_quantity,
    remainingQuantity: Math.max(0, r.allocated_quantity - r.sold_quantity),
    isAvailable: (r.allocated_quantity - r.sold_quantity) > 0
  }));
}

module.exports = {
  getAllocations,
  createAllocation,
  updateAllocationQuantity,
  getMyAllocations
};
