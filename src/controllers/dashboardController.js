const { query } = require('../config/db');
const { getISTDayBoundsUTC } = require('../utils/timeUtil');

async function getDashboardStats(req, res, next) {
  try {
    const eventId = req.effectiveEventId || req.query.eventId;
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    
    // Strict IST Calendar Day bounds converted to UTC SQL strings
    const { startUtc: todayStart, endUtc: todayEnd } = getISTDayBoundsUTC();

    const eventWhere = eventId ? 'WHERE event_id = ?' : '';
    const eventWhereSh = eventId ? 'AND sh.event_id = ?' : '';
    const eventParams = eventId ? [parseInt(eventId, 10)] : [];

    // Aggregate pass metrics
    const [passSummary] = await query(`
      SELECT
        COUNT(*) as total_passes,
        SUM(CASE WHEN printed = 1 THEN 1 ELSE 0 END) as total_printed,
        SUM(CASE WHEN printed = 0 THEN 1 ELSE 0 END) as total_unprinted,
        SUM(CASE WHEN status = 'used' OR scan_count > 0 THEN 1 ELSE 0 END) as total_used,
        SUM(CASE WHEN status != 'used' AND scan_count = 0 AND status != 'void' THEN 1 ELSE 0 END) as total_unused,
        SUM(CASE WHEN status = 'expired' OR (valid_until < '${now}' AND status != 'void') THEN 1 ELSE 0 END) as total_expired,
        SUM(CASE WHEN status = 'void' THEN 1 ELSE 0 END) as total_void
      FROM passes
      ${eventWhere}
    `, eventParams);

    // Category breakdown
    const categoryStats = await query(`
      SELECT
        c.id, c.code, c.name, c.total_quantity, c.event_id,
        COUNT(p.id) as actual_in_db,
        SUM(CASE WHEN p.printed = 1 THEN 1 ELSE 0 END) as printed_count,
        SUM(CASE WHEN p.status = 'used' OR p.scan_count > 0 THEN 1 ELSE 0 END) as used_count,
        SUM(CASE WHEN p.status = 'void' THEN 1 ELSE 0 END) as void_count
      FROM pass_categories c
      LEFT JOIN passes p ON (c.id = p.category_id OR (c.code = p.code_type AND c.event_id = p.event_id))
      ${eventId ? 'WHERE c.event_id = ?' : ''}
      GROUP BY c.id
      ORDER BY c.id ASC
    `, eventParams);

    // Today's scan statistics (based on IST day boundaries)
    const [todayStats] = await query(`
      SELECT
        COUNT(*) as total_scans_today,
        SUM(CASE WHEN result = 'approved' THEN 1 ELSE 0 END) as successful_scans_today,
        SUM(CASE WHEN result != 'approved' THEN 1 ELSE 0 END) as failed_scans_today
      FROM scan_history sh
      WHERE scan_time >= ? AND scan_time <= ? ${eventWhereSh}
    `, [todayStart, todayEnd, ...eventParams]);

    // Scans by Gate / Device
    const scansByDevice = await query(`
      SELECT
        device_id,
        COUNT(*) as total_scans,
        SUM(CASE WHEN result = 'approved' THEN 1 ELSE 0 END) as approved_scans,
        SUM(CASE WHEN result != 'approved' THEN 1 ELSE 0 END) as denied_scans
      FROM scan_history sh
      WHERE scan_time >= ? ${eventWhereSh}
      GROUP BY device_id
      ORDER BY total_scans DESC
      LIMIT 10
    `, [todayStart, ...eventParams]);

    // Recent activity feed
    const recentScans = await query(`
      SELECT sh.id, sh.pass_code, sh.pass_type, sh.device_id, sh.scan_time, sh.result, sh.reason,
             c.name as category_name, e.event_name
      FROM scan_history sh
      LEFT JOIN pass_categories c ON sh.category_id = c.id
      LEFT JOIN events e ON sh.event_id = e.id
      ${eventId ? 'WHERE sh.event_id = ?' : ''}
      ORDER BY sh.scan_time DESC
      LIMIT 15
    `, eventParams);

    // Active Print Batches
    const activeBatches = await query(`
      SELECT id, name, pass_type, total_requested, printed_count, status, created_at
      FROM print_batches
      WHERE status IN ('created', 'printing', 'paused') ${eventId ? 'AND event_id = ?' : ''}
      ORDER BY created_at DESC
      LIMIT 5
    `, eventParams);

    // Current event details if selected
    let currentEvent = null;
    if (eventId) {
      const [eventRows] = await query('SELECT * FROM events WHERE id = ?', [parseInt(eventId, 10)]);
      if (eventRows.length > 0) currentEvent = eventRows[0];
    }

    // Fraud detection summary
    const [fraudSummary] = await query(
      `SELECT COUNT(*) as total_fraud,
              SUM(CASE WHEN DATE(detected_at) = CURRENT_DATE() THEN 1 ELSE 0 END) as today_fraud
       FROM fraud_detections
       ${eventId ? 'WHERE event_id = ?' : ''}`,
      eventParams
    );

    res.json({
      success: true,
      currentEvent,
      stats: {
        totalPasses: passSummary?.total_passes || 0,
        totalPrinted: passSummary?.total_printed || 0,
        totalUnprinted: passSummary?.total_unprinted || 0,
        totalUsed: passSummary?.total_used || 0,
        totalUnused: passSummary?.total_unused || 0,
        totalExpired: passSummary?.total_expired || 0,
        totalVoid: passSummary?.total_void || 0,
        todayScans: todayStats?.total_scans_today || 0,
        successfulScansToday: todayStats?.successful_scans_today || 0,
        failedScansToday: todayStats?.failed_scans_today || 0,
        totalFraudDetections: fraudSummary?.total_fraud || 0,
        todayFraudDetections: fraudSummary?.today_fraud || 0
      },
      categoryStats,
      scansByDevice,
      recentScans,
      activeBatches
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getDashboardStats
};
