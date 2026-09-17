const { query } = require('../config/db');
const { logAudit } = require('./AuditService');

/**
 * Get dynamic scan checkpoints for an event
 */
async function getCheckpoints(eventId) {
  if (!eventId) return [];

  const rows = await query(
    `SELECT sc.*, e.event_name, u.name as created_by_name
     FROM scan_checkpoints sc
     JOIN events e ON sc.event_id = e.id
     LEFT JOIN users u ON sc.created_by = u.id
     WHERE sc.event_id = ?
     ORDER BY sc.display_order ASC, sc.id ASC`,
    [parseInt(eventId, 10)]
  );

  return rows.map(r => ({
    id: r.id,
    eventId: r.event_id,
    eventName: r.event_name,
    name: r.name,
    code: r.code,
    checkpoint_name: r.name,
    checkpoint_code: r.code,
    description: r.description,
    displayOrder: r.display_order,
    display_order: r.display_order,
    isActive: Boolean(r.is_active),
    is_active: r.is_active,
    maxScansPerPass: r.max_scans_per_pass,
    max_scans_per_pass: r.max_scans_per_pass,
    allowedCategories: r.allowed_categories ? (typeof r.allowed_categories === 'string' ? JSON.parse(r.allowed_categories) : r.allowed_categories) : null,
    createdByName: r.created_by_name,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }));
}

/**
 * Create a new scan checkpoint
 */
async function createCheckpoint({
  eventId,
  name,
  code,
  description = null,
  displayOrder = 0,
  maxScansPerPass = 1,
  allowedCategories = null,
  userId = null,
  userName = 'Admin',
  ipAddress = null,
  userAgent = null
}) {
  if (!eventId || !name || !name.trim()) {
    throw new Error('Event ID and Checkpoint Name are required');
  }

  const cleanName = name.trim();
  const cleanCode = (code || cleanName.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()).trim().toUpperCase();

  const cleanCats = allowedCategories ? (typeof allowedCategories === 'string' ? allowedCategories : JSON.stringify(allowedCategories)) : null;

  const insertRes = await query(
    `INSERT INTO scan_checkpoints (event_id, name, code, description, display_order, is_active, max_scans_per_pass, allowed_categories, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, TRUE, ?, ?, ?, NOW(), NOW())`,
    [
      parseInt(eventId, 10),
      cleanName,
      cleanCode,
      description ? description.trim() : null,
      parseInt(displayOrder, 10) || 0,
      parseInt(maxScansPerPass, 10) || 1,
      cleanCats,
      userId
    ]
  );

  const checkpointId = insertRes.insertId;

  await logAudit({
    userId,
    userName,
    action: 'CREATE_SCAN_CHECKPOINT',
    entity: 'SCAN_CHECKPOINT',
    entityId: checkpointId,
    newValue: { eventId, name: cleanName, code: cleanCode, maxScansPerPass },
    ipAddress,
    userAgent
  });

  return { checkpointId, name: cleanName, code: cleanCode };
}

/**
 * Update an existing scan checkpoint
 */
async function updateCheckpoint({
  id,
  name,
  code,
  description,
  displayOrder,
  isActive,
  maxScansPerPass,
  allowedCategories,
  userId = null,
  userName = 'Admin',
  ipAddress = null,
  userAgent = null
}) {
  const existing = await query('SELECT * FROM scan_checkpoints WHERE id = ?', [id]);
  if (!existing || existing.length === 0) {
    throw new Error('Checkpoint not found');
  }

  const current = existing[0];
  const newName = name !== undefined ? name.trim() : current.name;
  const newCode = code !== undefined ? code.trim().toUpperCase() : current.code;
  const newDesc = description !== undefined ? (description ? description.trim() : null) : current.description;
  const newOrder = displayOrder !== undefined ? parseInt(displayOrder, 10) : current.display_order;
  const newActive = isActive !== undefined ? (Boolean(isActive) ? 1 : 0) : current.is_active;
  const newMaxScans = maxScansPerPass !== undefined ? parseInt(maxScansPerPass, 10) : current.max_scans_per_pass;
  const newCats = allowedCategories !== undefined
    ? (allowedCategories ? (typeof allowedCategories === 'string' ? allowedCategories : JSON.stringify(allowedCategories)) : null)
    : current.allowed_categories;

  await query(
    `UPDATE scan_checkpoints
     SET name = ?, code = ?, description = ?, display_order = ?, is_active = ?,
         max_scans_per_pass = ?, allowed_categories = ?, updated_at = NOW()
     WHERE id = ?`,
    [newName, newCode, newDesc, newOrder, newActive, newMaxScans, newCats, id]
  );

  await logAudit({
    userId,
    userName,
    action: 'UPDATE_SCAN_CHECKPOINT',
    entity: 'SCAN_CHECKPOINT',
    entityId: id,
    oldValue: current,
    newValue: { name: newName, code: newCode, isActive: newActive, maxScansPerPass: newMaxScans },
    ipAddress,
    userAgent
  });

  return { success: true, id };
}

/**
 * Delete / deactivate a scan checkpoint
 */
async function deleteCheckpoint({ id, userId = null, userName = 'Admin', ipAddress = null, userAgent = null }) {
  const existing = await query('SELECT * FROM scan_checkpoints WHERE id = ?', [id]);
  if (!existing || existing.length === 0) {
    throw new Error('Checkpoint not found');
  }

  // Check if checkpoint has scan history; if so, soft delete (deactivate)
  const historyCount = await query('SELECT COUNT(*) as count FROM scan_history WHERE checkpoint_id = ?', [id]);
  if (historyCount && historyCount[0].count > 0) {
    await query('UPDATE scan_checkpoints SET is_active = FALSE, updated_at = NOW() WHERE id = ?', [id]);
  } else {
    await query('DELETE FROM scan_checkpoints WHERE id = ?', [id]);
  }

  await logAudit({
    userId,
    userName,
    action: 'DELETE_SCAN_CHECKPOINT',
    entity: 'SCAN_CHECKPOINT',
    entityId: id,
    oldValue: existing[0],
    ipAddress,
    userAgent
  });

  return { success: true, id };
}

module.exports = {
  getCheckpoints,
  createCheckpoint,
  updateCheckpoint,
  deleteCheckpoint
};
