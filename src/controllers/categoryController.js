const { query } = require('../config/db');
const { logAudit } = require('../services/AuditService');

async function getCategories(req, res, next) {
  try {
    const eventId = req.effectiveEventId || req.query.eventId;
    const whereConditions = [];
    const queryParams = [];

    if (eventId) {
      whereConditions.push('c.event_id = ?');
      queryParams.push(parseInt(eventId, 10));
    }

    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

    const categories = await query(
      `SELECT c.*,
              e.event_name,
              COUNT(p.id) as total_passes_in_db,
              SUM(CASE WHEN p.printed = 1 THEN 1 ELSE 0 END) as printed_count,
              SUM(CASE WHEN p.status = 'used' OR p.scan_count > 0 THEN 1 ELSE 0 END) as used_count
       FROM pass_categories c
       LEFT JOIN events e ON c.event_id = e.id
       LEFT JOIN passes p ON (c.id = p.category_id OR (c.code = p.code_type AND c.event_id = p.event_id))
       ${whereClause}
       GROUP BY c.id
       ORDER BY c.id ASC`,
      queryParams
    );

    res.json({
      success: true,
      data: categories
    });
  } catch (error) {
    next(error);
  }
}

async function createCategory(req, res, next) {
  try {
    const {
      eventId,
      name,
      code,
      categoryPrefix,
      description,
      validFrom,
      validUntil,
      totalQuantity = 0,
      maxDailyScans = 1,
      scanBehavior = 'ONE_TIME',
      renewalTime = '01:00',
      renewalActiveFrom = null,
      renewalActiveUntil = null,
      price = 0
    } = req.body;

    const targetEventId = req.effectiveEventId || eventId;
    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'];

    if (!targetEventId || !name || !code || !validFrom || !validUntil) {
      return res.status(400).json({ success: false, message: 'Event ID, Category Name, Code, and Validity dates are required' });
    }

    const behavior = (scanBehavior || 'ONE_TIME').toUpperCase() === 'RENEWABLE' ? 'RENEWABLE' : 'ONE_TIME';
    const renTime = renewalTime || '01:00';
    const renActiveFrom = behavior === 'RENEWABLE' ? (renewalActiveFrom || validFrom) : null;
    const renActiveUntil = behavior === 'RENEWABLE' ? (renewalActiveUntil || validUntil) : null;

    const result = await query(
      `INSERT INTO pass_categories (
        event_id, code, category_prefix, name, description,
        valid_from, valid_until, total_quantity, max_daily_scans,
        scan_behavior, renewal_time, renewal_active_from, renewal_active_until,
        price, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        targetEventId, code.trim().toLowerCase(), categoryPrefix || '', name.trim(), description || '',
        validFrom, validUntil, totalQuantity, maxDailyScans,
        behavior, renTime, renActiveFrom, renActiveUntil,
        price
      ]
    );

    await logAudit({
      eventId: targetEventId,
      userId: req.user?.id,
      userName: req.user?.name,
      action: 'CREATE_CATEGORY',
      entity: 'PASS_CATEGORY',
      entityId: result.insertId,
      newValue: { eventId: targetEventId, name, code, validFrom, validUntil, scanBehavior: behavior, renewalTime: renTime },
      ipAddress,
      userAgent
    });

    res.status(201).json({
      success: true,
      message: 'Category created successfully',
      data: { id: result.insertId, name, code, eventId: targetEventId, scanBehavior: behavior }
    });
  } catch (error) {
    next(error);
  }
}

async function updateCategory(req, res, next) {
  try {
    const { id } = req.params;
    const {
      name,
      categoryPrefix,
      description,
      validFrom,
      validUntil,
      maxDailyScans,
      scanBehavior,
      renewalTime,
      renewalActiveFrom,
      renewalActiveUntil,
      price
    } = req.body;

    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'];

    const existing = await query('SELECT * FROM pass_categories WHERE id = ?', [id]);
    if (existing.length === 0) {
      return res.status(404).json({ success: false, message: 'Category not found' });
    }

    const oldVal = existing[0];
    const behavior = scanBehavior !== undefined
      ? ((scanBehavior || 'ONE_TIME').toUpperCase() === 'RENEWABLE' ? 'RENEWABLE' : 'ONE_TIME')
      : oldVal.scan_behavior;
    const renTime = renewalTime !== undefined ? (renewalTime || '01:00') : oldVal.renewal_time;
    const renActiveFrom = behavior === 'RENEWABLE'
      ? (renewalActiveFrom !== undefined ? renewalActiveFrom : (oldVal.renewal_active_from || validFrom || oldVal.valid_from))
      : null;
    const renActiveUntil = behavior === 'RENEWABLE'
      ? (renewalActiveUntil !== undefined ? renewalActiveUntil : (oldVal.renewal_active_until || validUntil || oldVal.valid_until))
      : null;

    await query(
      `UPDATE pass_categories
       SET name = COALESCE(?, name),
           category_prefix = COALESCE(?, category_prefix),
           description = COALESCE(?, description),
           valid_from = COALESCE(?, valid_from),
           valid_until = COALESCE(?, valid_until),
           max_daily_scans = COALESCE(?, max_daily_scans),
           scan_behavior = ?,
           renewal_time = ?,
           renewal_active_from = ?,
           renewal_active_until = ?,
           price = COALESCE(?, price),
           updated_at = NOW()
       WHERE id = ?`,
      [
        name, categoryPrefix, description, validFrom, validUntil, maxDailyScans,
        behavior, renTime, renActiveFrom, renActiveUntil,
        price, id
      ]
    );

    await logAudit({
      eventId: oldVal.event_id,
      userId: req.user?.id,
      userName: req.user?.name,
      action: 'UPDATE_CATEGORY',
      entity: 'PASS_CATEGORY',
      entityId: id,
      oldValue: oldVal,
      newValue: { name, categoryPrefix, description, validFrom, validUntil, maxDailyScans, scanBehavior: behavior, renewalTime: renTime, price },
      ipAddress,
      userAgent
    });

    res.json({
      success: true,
      message: 'Category updated successfully'
    });
  } catch (error) {
    next(error);
  }
}

async function deleteCategory(req, res, next) {
  try {
    const { id } = req.params;
    const existing = await query('SELECT * FROM pass_categories WHERE id = ?', [id]);
    if (existing.length === 0) return res.status(404).json({ success: false, message: 'Category not found' });

    const cat = existing[0];
    const [passCount] = await query('SELECT COUNT(*) as count FROM passes WHERE category_id = ?', [id]);
    if (passCount[0].count > 0) {
      return res.status(400).json({ success: false, message: 'Cannot delete category with existing generated passes' });
    }

    await query('DELETE FROM pass_categories WHERE id = ?', [id]);
    await logAudit({
      eventId: cat.event_id,
      userId: req.user?.id,
      userName: req.user?.name,
      action: 'DELETE_CATEGORY',
      entity: 'PASS_CATEGORY',
      entityId: id,
      oldValue: cat,
      ipAddress: req.ip
    });

    res.json({ success: true, message: 'Category deleted successfully' });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getCategories,
  createCategory,
  updateCategory,
  deleteCategory
};
