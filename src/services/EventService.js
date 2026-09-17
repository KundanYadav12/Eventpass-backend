const { query } = require('../config/db');
const { logAudit } = require('./AuditService');
const { formatMySqlDateTime } = require('../utils/timeUtil');

async function getEvents({ status = '', search = '' } = {}, user = null) {
  const whereConditions = [];
  const queryParams = [];

  if (status && status !== 'all') {
    whereConditions.push('e.status = ?');
    queryParams.push(status);
  }

  if (search && search.trim()) {
    whereConditions.push('(e.event_name LIKE ? OR e.event_code LIKE ? OR e.venue LIKE ?)');
    const s = `%${search.trim()}%`;
    queryParams.push(s, s, s);
  }

  // Non-SuperAdmins can only see events assigned to them
  if (user && user.role !== 'SUPERADMIN') {
    if (user.role === 'SCANNER' || user.roleId === 4) {
      whereConditions.push('e.id = ?');
      queryParams.push(user.eventId || -1);
    } else {
      whereConditions.push(`(
        e.id IN (SELECT event_id FROM user_assigned_events WHERE user_id = ?)
        OR e.id IN (SELECT event_id FROM admin_event_permissions WHERE user_id = ?)
        OR e.id = ?
      )`);
      queryParams.push(user.id, user.id, user.eventId || -1);
    }
  }

  const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

  const sql = `
    SELECT e.*,
           COUNT(DISTINCT c.id) as category_count,
           COUNT(DISTINCT p.id) as total_passes,
           SUM(CASE WHEN p.printed = 1 THEN 1 ELSE 0 END) as printed_passes,
           SUM(CASE WHEN p.status = 'used' OR p.scan_count > 0 THEN 1 ELSE 0 END) as used_passes,
           COUNT(DISTINCT u.id) as admin_count
    FROM events e
    LEFT JOIN pass_categories c ON e.id = c.event_id
    LEFT JOIN passes p ON e.id = p.event_id
    LEFT JOIN users u ON e.id = u.event_id
    ${whereClause}
    GROUP BY e.id
    ORDER BY e.event_start_date DESC, e.id DESC
  `;

  return await query(sql, queryParams);
}

async function getEventById(id) {
  const events = await query('SELECT * FROM events WHERE id = ?', [id]);
  if (events.length === 0) return null;

  const event = events[0];

  // Fetch summary counts for this event
  const [counts] = await query(`
    SELECT
      COUNT(DISTINCT c.id) as category_count,
      COUNT(DISTINCT p.id) as total_passes,
      SUM(CASE WHEN p.printed = 1 THEN 1 ELSE 0 END) as printed_passes,
      SUM(CASE WHEN p.printed = 0 THEN 1 ELSE 0 END) as unprinted_passes,
      SUM(CASE WHEN p.status = 'used' OR p.scan_count > 0 THEN 1 ELSE 0 END) as used_passes,
      SUM(CASE WHEN p.status != 'used' AND p.scan_count = 0 THEN 1 ELSE 0 END) as unused_passes,
      SUM(CASE WHEN p.status = 'void' THEN 1 ELSE 0 END) as void_passes
    FROM events e
    LEFT JOIN pass_categories c ON e.id = c.event_id
    LEFT JOIN passes p ON e.id = p.event_id
    WHERE e.id = ?
  `, [id]);

  return {
    ...event,
    stats: counts || {}
  };
}

async function createEvent({ eventName, eventCode, description, venue, startDate, endDate, status = 'active', barcodeType = 'QR_CODE', stickerWidthMm = 38, stickerHeightMm = 50, userId, userName, ipAddress, userAgent }) {
  if (!eventName || !eventCode || !startDate || !endDate) {
    throw new Error('Event Name, Event Code, Start Date, and End Date are required');
  }

  const cleanCode = eventCode.trim().toUpperCase();
  const existing = await query('SELECT id FROM events WHERE event_code = ?', [cleanCode]);
  if (existing.length > 0) {
    throw new Error(`Event with code '${cleanCode}' already exists`);
  }

  const formattedStart = formatMySqlDateTime(startDate);
  const formattedEnd = formatMySqlDateTime(endDate);

  const result = await query(
    `INSERT INTO events (event_name, event_code, description, venue, event_start_date, event_end_date, status, barcode_type, sticker_width_mm, sticker_height_mm, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
    [eventName.trim(), cleanCode, description || '', venue || '', formattedStart, formattedEnd, status, barcodeType || 'QR_CODE', stickerWidthMm || 38, stickerHeightMm || 50]
  );

  const eventId = result.insertId;

  await logAudit({
    userId,
    userName,
    action: 'CREATE_EVENT',
    entity: 'EVENT',
    entityId: eventId,
    newValue: { eventName, eventCode: cleanCode, startDate: formattedStart, endDate: formattedEnd, status, barcodeType },
    ipAddress,
    userAgent
  });

  return getEventById(eventId);
}

async function updateEvent(id, { eventName, eventCode, description, venue, startDate, endDate, status, barcodeType, stickerWidthMm, stickerHeightMm, userId, userName, ipAddress, userAgent }) {
  const existing = await query('SELECT * FROM events WHERE id = ?', [id]);
  if (existing.length === 0) {
    throw new Error('Event not found');
  }

  const oldEvent = existing[0];
  const cleanCode = eventCode ? eventCode.trim().toUpperCase() : oldEvent.event_code;

  if (eventCode && cleanCode !== oldEvent.event_code) {
    const duplicate = await query('SELECT id FROM events WHERE event_code = ? AND id != ?', [cleanCode, id]);
    if (duplicate.length > 0) {
      throw new Error(`Event code '${cleanCode}' is already used by another event`);
    }
  }

  const formattedStart = startDate !== undefined ? formatMySqlDateTime(startDate) : oldEvent.event_start_date;
  const formattedEnd = endDate !== undefined ? formatMySqlDateTime(endDate) : oldEvent.event_end_date;

  await query(
    `UPDATE events
     SET event_name = COALESCE(?, event_name),
         event_code = COALESCE(?, event_code),
         description = COALESCE(?, description),
         venue = COALESCE(?, venue),
         event_start_date = COALESCE(?, event_start_date),
         event_end_date = COALESCE(?, event_end_date),
         status = COALESCE(?, status),
         barcode_type = COALESCE(?, barcode_type),
         sticker_width_mm = COALESCE(?, sticker_width_mm),
         sticker_height_mm = COALESCE(?, sticker_height_mm),
         updated_at = NOW()
     WHERE id = ?`,
    [eventName, cleanCode, description, venue, formattedStart, formattedEnd, status, barcodeType, stickerWidthMm, stickerHeightMm, id]
  );

  await logAudit({
    userId,
    userName,
    action: 'UPDATE_EVENT',
    entity: 'EVENT',
    entityId: id,
    oldValue: oldEvent,
    newValue: { eventName, eventCode: cleanCode, description, venue, startDate, endDate, status, barcodeType, stickerWidthMm, stickerHeightMm },
    ipAddress,
    userAgent
  });

  return getEventById(id);
}

async function toggleEventStatus(id, newStatus, { userId, userName, ipAddress, userAgent }) {
  await query('UPDATE events SET status = ?, updated_at = NOW() WHERE id = ?', [newStatus, id]);
  await logAudit({
    userId,
    userName,
    action: 'TOGGLE_EVENT_STATUS',
    entity: 'EVENT',
    entityId: id,
    newValue: { status: newStatus },
    ipAddress,
    userAgent
  });
  return { id, status: newStatus };
}

module.exports = {
  getEvents,
  getEventById,
  createEvent,
  updateEvent,
  toggleEventStatus
};
