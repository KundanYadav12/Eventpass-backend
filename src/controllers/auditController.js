const { query } = require('../config/db');

async function getAuditLogs(req, res, next) {
  try {
    const eventId = req.effectiveEventId || req.query.eventId;
    const {
      page = 1,
      limit = 20,
      action = '',
      entity = '',
      search = '',
      dateFrom = '',
      dateTo = ''
    } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const pageLimit = Math.min(100, Math.max(5, parseInt(limit, 10) || 20));
    const offset = (pageNum - 1) * pageLimit;

    const whereConditions = [];
    const queryParams = [];

    if (eventId) {
      whereConditions.push('(a.event_id = ? OR a.event_id IS NULL)');
      queryParams.push(parseInt(eventId, 10));
    }

    if (action && action !== 'all') {
      whereConditions.push('a.action = ?');
      queryParams.push(action);
    }

    if (entity && entity !== 'all') {
      whereConditions.push('a.entity = ?');
      queryParams.push(entity);
    }

    if (search && search.trim()) {
      whereConditions.push('(a.user_name LIKE ? OR a.entity_id LIKE ? OR a.action LIKE ?)');
      const s = `%${search.trim()}%`;
      queryParams.push(s, s, s);
    }

    if (dateFrom) {
      whereConditions.push('a.created_at >= ?');
      queryParams.push(`${dateFrom} 00:00:00`);
    }

    if (dateTo) {
      whereConditions.push('a.created_at <= ?');
      queryParams.push(`${dateTo} 23:59:59`);
    }

    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

    const [countResult] = await query(`SELECT COUNT(*) as total FROM audit_log a ${whereClause}`, queryParams);
    const totalRecords = countResult ? countResult.total : 0;
    const totalPages = Math.ceil(totalRecords / pageLimit);

    const logs = await query(
      `SELECT a.*, e.event_name
       FROM audit_log a
       LEFT JOIN events e ON a.event_id = e.id
       ${whereClause}
       ORDER BY a.created_at DESC
       LIMIT ? OFFSET ?`,
      [...queryParams, pageLimit, offset]
    );

    const actions = await query('SELECT DISTINCT action FROM audit_log ORDER BY action ASC');

    res.json({
      success: true,
      logs,
      actions: actions.map(a => a.action),
      pagination: {
        page: pageNum,
        limit: pageLimit,
        totalRecords,
        totalPages
      }
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getAuditLogs
};
