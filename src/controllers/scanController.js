const scanService = require('../services/ScanService');
const { query } = require('../config/db');

/**
 * Handle scan attempt from scanner app or web scanner
 */
async function scan(req, res, next) {
  try {
    const { code, deviceId = 'GATE-01', targetEventId = null, checkpointId = null, scanSource = 'camera' } = req.body;
    const operatorId = req.user?.id || null;
    const operatorName = req.user?.name || null;
    const operatorRole = req.user?.role || null;
    const operatorEventId = req.user?.eventId || null;
    const ipAddress = req.ip || req.connection.remoteAddress;

    if (!code) {
      return res.status(400).json({
        success: false,
        result: 'invalid',
        message: 'Pass code is required'
      });
    }

    // Strictly lock SCANNER accounts to their assigned event
    const isScanner = operatorRole === 'SCANNER' || req.user?.roleId === 4;
    const resolvedTargetEventId = isScanner
      ? operatorEventId
      : (targetEventId || req.effectiveEventId || null);

    const result = await scanService.processScan({
      code,
      deviceId,
      operatorId,
      operatorName,
      operatorRole,
      operatorEventId,
      targetEventId: resolvedTargetEventId,
      checkpointId: checkpointId ? parseInt(checkpointId, 10) : null,
      scanSource,
      ipAddress
    });

    res.json(result);
  } catch (error) {
    next(error);
  }
}

/**
 * Get paginated scan history scoped by eventId with filters
 */
async function getScanHistory(req, res, next) {
  try {
    let eventId = req.effectiveEventId || req.query.eventId;
    if (req.user?.role === 'SCANNER' || req.user?.roleId === 4) {
      eventId = req.user.eventId;
    }
    const {
      page = 1,
      limit = 20,
      search = '',
      result = '',
      passType = '',
      deviceId = '',
      checkpointId = '',
      scanSource = '',
      dateFrom = '',
      dateTo = ''
    } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const pageLimit = Math.min(100, Math.max(5, parseInt(limit, 10) || 20));
    const offset = (pageNum - 1) * pageLimit;

    const whereConditions = [];
    const queryParams = [];

    if (eventId) {
      whereConditions.push('sh.event_id = ?');
      queryParams.push(parseInt(eventId, 10));
    }

    if (checkpointId && checkpointId !== 'all') {
      whereConditions.push('sh.checkpoint_id = ?');
      queryParams.push(parseInt(checkpointId, 10));
    }

    if (scanSource && scanSource !== 'all') {
      whereConditions.push('sh.scan_source = ?');
      queryParams.push(scanSource);
    }

    if (search && search.trim()) {
      whereConditions.push('sh.pass_code LIKE ?');
      queryParams.push(`%${search.trim()}%`);
    }

    if (result && result !== 'all') {
      whereConditions.push('sh.result = ?');
      queryParams.push(result);
    }

    if (passType && passType !== 'all') {
      whereConditions.push('(sh.pass_type = ? OR c.code = ?)');
      queryParams.push(passType, passType);
    }

    if (deviceId && deviceId !== 'all') {
      whereConditions.push('sh.device_id = ?');
      queryParams.push(deviceId);
    }

    if (dateFrom) {
      whereConditions.push('sh.scan_time >= ?');
      queryParams.push(`${dateFrom} 00:00:00`);
    }

    if (dateTo) {
      whereConditions.push('sh.scan_time <= ?');
      queryParams.push(`${dateTo} 23:59:59`);
    }

    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

    const [countResult] = await query(
      `SELECT COUNT(*) as total
       FROM scan_history sh
       LEFT JOIN pass_categories c ON sh.category_id = c.id
       ${whereClause}`,
      queryParams
    );
    const totalRecords = countResult ? countResult.total : 0;
    const totalPages = Math.ceil(totalRecords / pageLimit);

    const history = await query(
      `SELECT sh.*, u.name as operator_name, c.name as category_name, e.event_name,
              sc.name as checkpoint_name, sc.code as checkpoint_code
       FROM scan_history sh
       LEFT JOIN users u ON sh.operator_id = u.id
       LEFT JOIN pass_categories c ON sh.category_id = c.id
       LEFT JOIN events e ON sh.event_id = e.id
       LEFT JOIN scan_checkpoints sc ON sh.checkpoint_id = sc.id
       ${whereClause}
       ORDER BY sh.scan_time DESC
       LIMIT ? OFFSET ?`,
      [...queryParams, pageLimit, offset]
    );

    const devices = await query(
      `SELECT DISTINCT device_id FROM scan_history ${eventId ? 'WHERE event_id = ?' : ''} ORDER BY device_id ASC`,
      eventId ? [parseInt(eventId, 10)] : []
    );

    res.json({
      success: true,
      history,
      devices: devices.map(d => d.device_id),
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

/**
 * Get Fraud Detections Summary and Recent Fraud Logs
 */
async function getFraudStats(req, res, next) {
  try {
    const eventId = req.effectiveEventId || req.query.eventId || null;
    const stats = await scanService.getFraudStats({ eventId });
    res.json({
      success: true,
      ...stats
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  scan,
  getScanHistory,
  getFraudStats
};
