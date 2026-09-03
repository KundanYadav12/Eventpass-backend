const { query, withTransaction } = require('../config/db');
const { logAudit } = require('./AuditService');

/**
 * List pass styles with event-scoping
 */
async function getStyles({ eventId = null, isSuperAdmin = false }) {
  const whereConditions = [];
  const queryParams = [];

  if (!isSuperAdmin && eventId) {
    whereConditions.push('(s.event_id = ? OR s.event_id IS NULL)');
    queryParams.push(parseInt(eventId, 10));
  } else if (eventId) {
    whereConditions.push('(s.event_id = ? OR s.event_id IS NULL)');
    queryParams.push(parseInt(eventId, 10));
  }

  const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

  const styles = await query(
    `SELECT s.*, e.event_name, u.name as creator_name
     FROM pass_styles s
     LEFT JOIN events e ON s.event_id = e.id
     LEFT JOIN users u ON s.created_by = u.id
     ${whereClause}
     ORDER BY s.is_default DESC, s.id DESC`,
    queryParams
  );

  return styles.map(s => ({
    ...s,
    elements_config: typeof s.elements_config === 'string' ? JSON.parse(s.elements_config) : s.elements_config
  }));
}

/**
 * Get single pass style by ID
 */
async function getStyleById(id) {
  const styles = await query(
    `SELECT s.*, e.event_name, u.name as creator_name
     FROM pass_styles s
     LEFT JOIN events e ON s.event_id = e.id
     LEFT JOIN users u ON s.created_by = u.id
     WHERE s.id = ?`,
    [id]
  );

  if (styles.length === 0) return null;

  const s = styles[0];
  return {
    ...s,
    elements_config: typeof s.elements_config === 'string' ? JSON.parse(s.elements_config) : s.elements_config
  };
}

/**
 * Create a new Pass Style
 */
async function createStyle({
  eventId = null,
  name,
  description = '',
  backgroundImageUrl = null,
  canvasWidth = 800,
  canvasHeight = 1200,
  elementsConfig = [],
  isDefault = false,
  userId = null,
  userName = '',
  ipAddress = null,
  userAgent = null
}) {
  if (!name || !name.trim()) {
    throw new Error('Pass Style name is required');
  }

  const cleanElements = Array.isArray(elementsConfig) ? elementsConfig : [];
  const elementsJson = JSON.stringify(cleanElements);

  const result = await query(
    `INSERT INTO pass_styles (event_id, name, description, background_image_url, canvas_width, canvas_height, elements_config, is_default, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
    [
      eventId ? parseInt(eventId, 10) : null,
      name.trim(),
      description ? description.trim() : '',
      backgroundImageUrl || null,
      parseInt(canvasWidth, 10) || 800,
      parseInt(canvasHeight, 10) || 1200,
      elementsJson,
      isDefault ? 1 : 0,
      userId
    ]
  );

  const styleId = result.insertId;

  await logAudit({
    eventId,
    userId,
    userName,
    action: 'CREATE_PASS_STYLE',
    entity: 'PASS_STYLE',
    entityId: styleId,
    newValue: { name, eventId, canvasWidth, canvasHeight, isDefault },
    ipAddress,
    userAgent
  });

  return getStyleById(styleId);
}

/**
 * Update an existing Pass Style
 */
async function updateStyle(id, {
  name,
  description,
  backgroundImageUrl,
  canvasWidth,
  canvasHeight,
  elementsConfig,
  isDefault,
  eventId,
  isSuperAdmin = false,
  userId = null,
  userName = '',
  ipAddress = null,
  userAgent = null
}) {
  const existing = await query('SELECT * FROM pass_styles WHERE id = ?', [id]);
  if (existing.length === 0) {
    throw new Error('Pass Style not found');
  }

  const old = existing[0];

  // Event Admin permission check: cannot edit styles belonging to another event
  if (!isSuperAdmin && old.event_id && parseInt(old.event_id, 10) !== parseInt(eventId, 10)) {
    throw new Error('Forbidden: You can only edit pass styles for your assigned event');
  }

  const elementsJson = elementsConfig !== undefined
    ? JSON.stringify(Array.isArray(elementsConfig) ? elementsConfig : [])
    : old.elements_config;

  await query(
    `UPDATE pass_styles
     SET name = COALESCE(?, name),
         description = COALESCE(?, description),
         background_image_url = ?,
         canvas_width = COALESCE(?, canvas_width),
         canvas_height = COALESCE(?, canvas_height),
         elements_config = ?,
         is_default = COALESCE(?, is_default),
         updated_at = NOW()
     WHERE id = ?`,
    [
      name ? name.trim() : null,
      description !== undefined ? description : null,
      backgroundImageUrl !== undefined ? backgroundImageUrl : old.background_image_url,
      canvasWidth ? parseInt(canvasWidth, 10) : null,
      canvasHeight ? parseInt(canvasHeight, 10) : null,
      elementsJson,
      isDefault !== undefined ? (isDefault ? 1 : 0) : null,
      id
    ]
  );

  await logAudit({
    eventId: old.event_id,
    userId,
    userName,
    action: 'UPDATE_PASS_STYLE',
    entity: 'PASS_STYLE',
    entityId: id,
    oldValue: old,
    newValue: { name, description, canvasWidth, canvasHeight, isDefault },
    ipAddress,
    userAgent
  });

  return getStyleById(id);
}

/**
 * Delete Pass Style
 */
async function deleteStyle(id, { eventId, isSuperAdmin = false, userId = null, userName = '', ipAddress = null }) {
  const existing = await query('SELECT * FROM pass_styles WHERE id = ?', [id]);
  if (existing.length === 0) {
    throw new Error('Pass Style not found');
  }

  const old = existing[0];
  if (!isSuperAdmin && old.event_id && parseInt(old.event_id, 10) !== parseInt(eventId, 10)) {
    throw new Error('Forbidden: You can only delete pass styles for your assigned event');
  }

  await query('DELETE FROM pass_styles WHERE id = ?', [id]);

  await logAudit({
    eventId: old.event_id,
    userId,
    userName,
    action: 'DELETE_PASS_STYLE',
    entity: 'PASS_STYLE',
    entityId: id,
    oldValue: old,
    ipAddress
  });

  return { success: true, message: 'Pass style deleted successfully' };
}

module.exports = {
  getStyles,
  getStyleById,
  createStyle,
  updateStyle,
  deleteStyle
};
