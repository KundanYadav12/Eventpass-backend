const { query } = require('../config/db');

async function logAudit({
  userId = null,
  userName = null,
  action,
  entity,
  entityId = null,
  oldValue = null,
  newValue = null,
  ipAddress = null,
  userAgent = null
}) {
  try {
    const oldJson = oldValue !== null ? JSON.stringify(oldValue) : null;
    const newJson = newValue !== null ? JSON.stringify(newValue) : null;

    await query(
      `INSERT INTO audit_log (user_id, user_name, action, entity, entity_id, old_value, new_value, ip_address, user_agent, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [userId, userName, action, entity, String(entityId || ''), oldJson, newJson, ipAddress, userAgent]
    );
  } catch (error) {
    console.error('[AuditService Error] Failed to write audit log:', error.message);
  }
}

module.exports = {
  logAudit
};
