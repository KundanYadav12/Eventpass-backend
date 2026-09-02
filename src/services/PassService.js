const { query, withTransaction } = require('../config/db');
const { generatePassCode, generateHmacSignature } = require('../utils/cryptoUtil');
const { logAudit } = require('./AuditService');

/**
 * Get paginated list of passes with event scoping and dynamic filters
 */
async function getPasses({
  eventId = null,
  categoryId = null,
  page = 1,
  limit = 20,
  search = '',
  passType = '',
  status = '',
  printed = '',
  usageState = '',
  validityState = '',
  dateFrom = '',
  dateTo = '',
  sortBy = 'id',
  sortDir = 'ASC'
}) {
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const pageLimit = Math.min(100, Math.max(10, parseInt(limit, 10) || 20));
  const offset = (pageNum - 1) * pageLimit;

  const whereConditions = [];
  const queryParams = [];

  // Scoped by event_id
  if (eventId) {
    whereConditions.push('p.event_id = ?');
    queryParams.push(parseInt(eventId, 10));
  }

  // Scoped by category_id
  if (categoryId && categoryId !== 'all') {
    whereConditions.push('p.category_id = ?');
    queryParams.push(parseInt(categoryId, 10));
  }

  // Search by 7-char code or numeric ID
  if (search && search.trim()) {
    const cleanSearch = search.trim();
    if (/^\d+$/.test(cleanSearch)) {
      whereConditions.push('(p.id = ? OR p.code LIKE ?)');
      queryParams.push(parseInt(cleanSearch, 10), `%${cleanSearch}%`);
    } else {
      whereConditions.push('p.code LIKE ?');
      queryParams.push(`%${cleanSearch}%`);
    }
  }

  // Filter by Pass Type / Category code
  if (passType && passType !== 'all') {
    whereConditions.push('(p.code_type = ? OR c.code = ?)');
    queryParams.push(passType, passType);
  }

  // Filter by Status (active, used, expired, void)
  if (status && status !== 'all') {
    whereConditions.push('p.status = ?');
    queryParams.push(status);
  }

  // Filter by Printed status
  if (printed === 'true' || printed === '1') {
    whereConditions.push('p.printed = 1');
  } else if (printed === 'false' || printed === '0') {
    whereConditions.push('p.printed = 0');
  }

  // Filter by Used / Unused
  if (usageState === 'used') {
    whereConditions.push('(p.status = "used" OR p.scan_count > 0)');
  } else if (usageState === 'unused') {
    whereConditions.push('(p.status != "used" AND p.scan_count = 0)');
  }

  // Filter by Validity (valid / expired)
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  if (validityState === 'valid') {
    whereConditions.push('p.valid_until >= ? AND p.status != "void" AND p.status != "expired"');
    queryParams.push(now);
  } else if (validityState === 'expired') {
    whereConditions.push('(p.valid_until < ? OR p.status = "expired")');
    queryParams.push(now);
  }

  // Date Range filter
  if (dateFrom) {
    whereConditions.push('p.valid_from >= ?');
    queryParams.push(`${dateFrom} 00:00:00`);
  }
  if (dateTo) {
    whereConditions.push('p.valid_until <= ?');
    queryParams.push(`${dateTo} 23:59:59`);
  }

  const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

  const allowedSorts = ['id', 'code', 'code_type', 'status', 'valid_from', 'valid_until', 'scan_count', 'printed', 'created_at', 'last_scanned_at'];
  const safeSortBy = allowedSorts.includes(sortBy) ? `p.${sortBy}` : 'p.id';
  const safeSortDir = sortDir.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';

  // Count total records
  const countSql = `
    SELECT COUNT(*) as total
    FROM passes p
    LEFT JOIN pass_categories c ON p.category_id = c.id
    ${whereClause}
  `;
  const [countResult] = await query(countSql, queryParams);
  const totalRecords = countResult ? countResult.total : 0;
  const totalPages = Math.ceil(totalRecords / pageLimit);

  // Fetch paginated rows
  const dataSql = `
    SELECT p.id, p.event_id, p.category_id, p.code, p.code_type, p.category_prefix, p.status,
           p.valid_from, p.valid_until, p.issued_at, p.first_scanned_at, p.last_scanned_at,
           p.scan_count, p.printed, p.print_batch_id, p.created_at, p.updated_at,
           c.name as category_name, e.event_name, e.event_code
    FROM passes p
    LEFT JOIN pass_categories c ON (p.category_id = c.id OR (p.code_type = c.code AND p.event_id = c.event_id))
    LEFT JOIN events e ON p.event_id = e.id
    ${whereClause}
    ORDER BY ${safeSortBy} ${safeSortDir}
    LIMIT ? OFFSET ?
  `;

  const passes = await query(dataSql, [...queryParams, pageLimit, offset]);

  return {
    passes,
    pagination: {
      page: pageNum,
      limit: pageLimit,
      totalRecords,
      totalPages,
      hasPrev: pageNum > 1,
      hasNext: pageNum < totalPages
    }
  };
}

/**
 * Get single pass details with scan history and print logs
 */
async function getPassDetails(id) {
  const passes = await query(
    `SELECT p.*,
            c.name as category_name, c.description as category_description,
            e.id as event_id, e.event_name, e.event_code,
            pb.name as print_batch_name, pb.status as print_batch_status
     FROM passes p
     LEFT JOIN pass_categories c ON (p.category_id = c.id OR (p.code_type = c.code AND p.event_id = c.event_id))
     LEFT JOIN events e ON p.event_id = e.id
     LEFT JOIN print_batches pb ON p.print_batch_id = pb.id
     WHERE p.id = ?`,
    [id]
  );

  if (passes.length === 0) {
    return null;
  }

  const pass = passes[0];

  // Fetch scan history
  const scanHistory = await query(
    `SELECT sh.*, u.name as operator_name
     FROM scan_history sh
     LEFT JOIN users u ON sh.operator_id = u.id
     WHERE sh.pass_id = ? OR sh.pass_code = ?
     ORDER BY sh.scan_time DESC
     LIMIT 50`,
    [pass.id, pass.code]
  );

  // Fetch print logs
  const printLogs = await query(
    `SELECT pl.*, pb.name as batch_name
     FROM print_log pl
     LEFT JOIN print_batches pb ON pl.batch_id = pb.id
     WHERE pl.pass_id = ?
     ORDER BY pl.printed_at DESC`,
    [pass.id]
  );

  // Fetch audit history
  const auditHistory = await query(
    `SELECT * FROM audit_log
     WHERE entity = 'PASS' AND entity_id = ?
     ORDER BY created_at DESC
     LIMIT 20`,
    [String(pass.id)]
  );

  return {
    pass,
    scanHistory,
    printLogs,
    auditHistory
  };
}

/**
 * Generate passes for an event and category with collision-protected 7-character unique codes
 */
async function generatePasses({ eventId, categoryId, quantity, userId, userName, ipAddress, userAgent }) {
  const targetEventId = parseInt(eventId, 10);
  const targetCatId = parseInt(categoryId, 10);
  const count = parseInt(quantity, 10);

  if (!targetEventId || !targetCatId || !count || count <= 0) {
    throw new Error('Valid Event ID, Category ID, and Quantity are required');
  }

  const categoryRows = await query('SELECT * FROM pass_categories WHERE id = ? AND event_id = ?', [targetCatId, targetEventId]);
  if (!categoryRows || categoryRows.length === 0) {
    throw new Error('Category not found for the specified event');
  }

  const cat = categoryRows[0];
  const BATCH_CHUNK = 250;
  let generatedTotal = 0;

  await withTransaction(async (conn) => {
    while (generatedTotal < count) {
      const thisChunkSize = Math.min(BATCH_CHUNK, count - generatedTotal);
      const rows = [];

      for (let i = 0; i < thisChunkSize; i++) {
        const code = generatePassCode(); // Strictly 7-character unique code
        const hmac = generateHmacSignature(code);
        rows.push([
          targetEventId,
          cat.id,
          code,
          cat.code,
          cat.category_prefix || '',
          hmac,
          'active',
          cat.valid_from,
          cat.valid_until,
          false
        ]);
      }

      const placeholders = rows.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(',');
      const flatParams = rows.flat();

      const [insertRes] = await conn.query(
        `INSERT IGNORE INTO passes (event_id, category_id, code, code_type, category_prefix, hmac_sig, status, valid_from, valid_until, printed)
         VALUES ${placeholders}`,
        flatParams
      );

      generatedTotal += insertRes.affectedRows;
    }

    // Update category total_quantity
    await conn.query('UPDATE pass_categories SET total_quantity = total_quantity + ? WHERE id = ?', [generatedTotal, cat.id]);

    await conn.query(
      `INSERT INTO audit_log (event_id, user_id, user_name, action, entity, entity_id, new_value, ip_address, user_agent, created_at)
       VALUES (?, ?, ?, 'GENERATE_PASSES', 'PASS_CATEGORY', ?, ?, ?, ?, NOW())`,
      [
        targetEventId,
        userId,
        userName,
        String(cat.id),
        JSON.stringify({ eventId: targetEventId, categoryId: cat.id, generated: generatedTotal }),
        ipAddress,
        userAgent
      ]
    );
  });

  return {
    success: true,
    eventId: targetEventId,
    categoryId: cat.id,
    generatedCount: generatedTotal
  };
}

/**
 * Renew an individual pass
 */
async function renewPass(id, { validFrom, validUntil, resetUsage = false, resetStatus = true, reason, userId, userName, ipAddress, userAgent }) {
  const existing = await query('SELECT * FROM passes WHERE id = ?', [id]);
  if (existing.length === 0) {
    throw new Error('Pass not found');
  }

  const oldPass = existing[0];
  const newValidFrom = validFrom || oldPass.valid_from;
  const newValidUntil = validUntil || oldPass.valid_until;
  const newStatus = resetStatus ? 'active' : oldPass.status;
  const newScanCount = resetUsage ? 0 : oldPass.scan_count;
  const newFirstScanned = resetUsage ? null : oldPass.first_scanned_at;
  const newLastScanned = resetUsage ? null : oldPass.last_scanned_at;

  await query(
    `UPDATE passes
     SET valid_from = ?,
         valid_until = ?,
         status = ?,
         scan_count = ?,
         first_scanned_at = ?,
         last_scanned_at = ?,
         updated_at = NOW()
     WHERE id = ?`,
    [newValidFrom, newValidUntil, newStatus, newScanCount, newFirstScanned, newLastScanned, id]
  );

  await logAudit({
    eventId: oldPass.event_id,
    userId,
    userName,
    action: 'RENEW_PASS',
    entity: 'PASS',
    entityId: id,
    oldValue: { valid_from: oldPass.valid_from, valid_until: oldPass.valid_until, status: oldPass.status, scan_count: oldPass.scan_count },
    newValue: { valid_from: newValidFrom, valid_until: newValidUntil, status: newStatus, scan_count: newScanCount, reason: reason || 'Manual pass renewal' },
    ipAddress,
    userAgent
  });

  return getPassDetails(id);
}

/**
 * Bulk renew a group of passes
 */
async function bulkRenewPasses({ passIds = [], validFrom, validUntil, resetUsage = false, resetStatus = true, reason, userId, userName, ipAddress, userAgent }) {
  if (!Array.isArray(passIds) || passIds.length === 0) {
    throw new Error('No pass IDs provided for bulk renewal');
  }

  const results = await withTransaction(async (conn) => {
    let updatedCount = 0;

    for (const id of passIds) {
      const [rows] = await conn.query('SELECT * FROM passes WHERE id = ? FOR UPDATE', [id]);
      if (rows.length === 0) continue;

      const oldPass = rows[0];
      const newValidFrom = validFrom || oldPass.valid_from;
      const newValidUntil = validUntil || oldPass.valid_until;
      const newStatus = resetStatus ? 'active' : oldPass.status;
      const newScanCount = resetUsage ? 0 : oldPass.scan_count;

      await conn.query(
        `UPDATE passes
         SET valid_from = ?,
             valid_until = ?,
             status = ?,
             scan_count = ?,
             first_scanned_at = IF(? = 1, NULL, first_scanned_at),
             last_scanned_at = IF(? = 1, NULL, last_scanned_at),
             updated_at = NOW()
         WHERE id = ?`,
        [newValidFrom, newValidUntil, newStatus, newScanCount, resetUsage ? 1 : 0, resetUsage ? 1 : 0, id]
      );

      await conn.query(
        `INSERT INTO audit_log (event_id, user_id, user_name, action, entity, entity_id, old_value, new_value, ip_address, user_agent, created_at)
         VALUES (?, ?, ?, 'BULK_RENEW_PASS', 'PASS', ?, ?, ?, ?, ?, NOW())`,
        [
          oldPass.event_id,
          userId,
          userName,
          String(id),
          JSON.stringify({ valid_from: oldPass.valid_from, valid_until: oldPass.valid_until, status: oldPass.status }),
          JSON.stringify({ valid_from: newValidFrom, valid_until: newValidUntil, status: newStatus, reason }),
          ipAddress,
          userAgent
        ]
      );

      updatedCount++;
    }

    return { updatedCount };
  });

  return results;
}

/**
 * Void a pass
 */
async function voidPass(id, { reason, userId, userName, ipAddress, userAgent }) {
  const existing = await query('SELECT * FROM passes WHERE id = ?', [id]);
  if (existing.length === 0) {
    throw new Error('Pass not found');
  }

  const oldPass = existing[0];
  await query('UPDATE passes SET status = "void", updated_at = NOW() WHERE id = ?', [id]);

  await logAudit({
    eventId: oldPass.event_id,
    userId,
    userName,
    action: 'VOID_PASS',
    entity: 'PASS',
    entityId: id,
    oldValue: { status: oldPass.status },
    newValue: { status: 'void', reason: reason || 'SuperAdmin voided pass' },
    ipAddress,
    userAgent
  });

  return getPassDetails(id);
}

/**
 * Reissue a pass with new 7-character code and HMAC
 */
async function reissuePass(id, { reason, userId, userName, ipAddress, userAgent }) {
  const existing = await query('SELECT * FROM passes WHERE id = ?', [id]);
  if (existing.length === 0) {
    throw new Error('Pass not found');
  }

  const oldPass = existing[0];
  const newCode = generatePassCode(); // Strictly 7 characters
  const newHmac = generateHmacSignature(newCode);

  await query(
    `UPDATE passes
     SET code = ?,
         hmac_sig = ?,
         status = 'active',
         scan_count = 0,
         first_scanned_at = NULL,
         last_scanned_at = NULL,
         printed = 0,
         print_batch_id = NULL,
         updated_at = NOW()
     WHERE id = ?`,
    [newCode, newHmac, id]
  );

  await logAudit({
    eventId: oldPass.event_id,
    userId,
    userName,
    action: 'REISSUE_PASS',
    entity: 'PASS',
    entityId: id,
    oldValue: { code: oldPass.code, status: oldPass.status },
    newValue: { code: newCode, status: 'active', reason: reason || 'SuperAdmin reissued pass' },
    ipAddress,
    userAgent
  });

  return getPassDetails(id);
}

module.exports = {
  getPasses,
  getPassDetails,
  generatePasses,
  renewPass,
  bulkRenewPasses,
  voidPass,
  reissuePass
};
