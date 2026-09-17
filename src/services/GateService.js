const { query } = require('../config/db');
const { logAudit } = require('./AuditService');

/**
 * Get dynamic gates for an event
 */
async function getGates(eventId, includeInactive = false) {
  if (!eventId) return [];

  const whereConditions = ['eg.event_id = ?'];
  const queryParams = [parseInt(eventId, 10)];

  if (!includeInactive) {
    whereConditions.push('eg.is_active = TRUE');
  }

  const rows = await query(
    `SELECT eg.*, e.event_name, u.name as created_by_name
     FROM event_gates eg
     JOIN events e ON eg.event_id = e.id
     LEFT JOIN users u ON eg.created_by = u.id
     WHERE ${whereConditions.join(' AND ')}
     ORDER BY eg.display_order ASC, eg.id ASC`,
    queryParams
  );

  return rows.map(r => ({
    id: r.id,
    eventId: r.event_id,
    eventName: r.event_name,
    gateName: r.gate_name,
    gate_name: r.gate_name,
    gateCode: r.gate_code,
    gate_code: r.gate_code,
    description: r.description,
    displayOrder: r.display_order,
    display_order: r.display_order,
    isActive: Boolean(r.is_active),
    is_active: r.is_active,
    createdByName: r.created_by_name,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }));
}

/**
 * Create a new event gate / device
 */
async function createGate({
  eventId,
  gateName,
  gateCode,
  description = null,
  displayOrder = 0,
  userId = null,
  userName = 'Admin',
  ipAddress = null,
  userAgent = null
}) {
  if (!eventId || !gateName || !gateName.trim()) {
    throw new Error('Event ID and Gate Name are required');
  }

  const cleanName = gateName.trim();
  const cleanCode = (gateCode || cleanName.replace(/[^A-Za-z0-9]/g, '-').toUpperCase()).trim().toUpperCase();

  const insertRes = await query(
    `INSERT INTO event_gates (event_id, gate_name, gate_code, description, display_order, is_active, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, TRUE, ?, NOW(), NOW())`,
    [
      parseInt(eventId, 10),
      cleanName,
      cleanCode,
      description ? description.trim() : null,
      parseInt(displayOrder, 10) || 0,
      userId
    ]
  );

  const gateId = insertRes.insertId;

  await logAudit({
    userId,
    userName,
    action: 'CREATE_EVENT_GATE',
    entity: 'EVENT_GATE',
    entityId: gateId,
    newValue: { eventId, gateName: cleanName, gateCode: cleanCode },
    ipAddress,
    userAgent
  });

  return { gateId, gateName: cleanName, gateCode: cleanCode };
}

/**
 * Update an existing event gate
 */
async function updateGate({
  id,
  gateName,
  gateCode,
  description,
  displayOrder,
  isActive,
  userId = null,
  userName = 'Admin',
  ipAddress = null,
  userAgent = null
}) {
  const existing = await query('SELECT * FROM event_gates WHERE id = ?', [id]);
  if (!existing || existing.length === 0) {
    throw new Error('Gate not found');
  }

  const current = existing[0];
  const newName = gateName !== undefined ? gateName.trim() : current.gate_name;
  const newCode = gateCode !== undefined ? gateCode.trim().toUpperCase() : current.gate_code;
  const newDesc = description !== undefined ? (description ? description.trim() : null) : current.description;
  const newOrder = displayOrder !== undefined ? parseInt(displayOrder, 10) : current.display_order;
  const newActive = isActive !== undefined ? (Boolean(isActive) ? 1 : 0) : current.is_active;

  await query(
    `UPDATE event_gates
     SET gate_name = ?, gate_code = ?, description = ?, display_order = ?, is_active = ?, updated_at = NOW()
     WHERE id = ?`,
    [newName, newCode, newDesc, newOrder, newActive, id]
  );

  await logAudit({
    userId,
    userName,
    action: 'UPDATE_EVENT_GATE',
    entity: 'EVENT_GATE',
    entityId: id,
    oldValue: current,
    newValue: { gateName: newName, gateCode: newCode, isActive: newActive },
    ipAddress,
    userAgent
  });

  return { success: true, id };
}

/**
 * Delete an event gate
 */
async function deleteGate({ id, userId = null, userName = 'Admin', ipAddress = null, userAgent = null }) {
  const existing = await query('SELECT * FROM event_gates WHERE id = ?', [id]);
  if (!existing || existing.length === 0) {
    throw new Error('Gate not found');
  }

  await query('DELETE FROM event_gates WHERE id = ?', [id]);

  await logAudit({
    userId,
    userName,
    action: 'DELETE_EVENT_GATE',
    entity: 'EVENT_GATE',
    entityId: id,
    oldValue: existing[0],
    ipAddress,
    userAgent
  });

  return { success: true, id };
}

module.exports = {
  getGates,
  createGate,
  updateGate,
  deleteGate
};
