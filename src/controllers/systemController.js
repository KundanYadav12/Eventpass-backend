const { query } = require('../config/db');
const { logAudit } = require('../services/AuditService');

/**
 * Get all system settings (Public or Authenticated)
 */
async function getSystemSettings(req, res, next) {
  try {
    const rows = await query('SELECT setting_key, setting_value, description FROM system_settings');
    const settings = {};
    rows.forEach(r => {
      settings[r.setting_key] = r.setting_value;
    });

    res.json({
      success: true,
      settings: {
        platform_name: settings.platform_name || 'EventGen',
        ...settings
      }
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Update system settings (SuperAdmin only)
 */
async function updateSystemSettings(req, res, next) {
  try {
    const { platform_name, ...otherSettings } = req.body;
    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'];

    if (platform_name !== undefined) {
      const cleanName = String(platform_name).trim() || 'EventGen';
      await query(
        `INSERT INTO system_settings (setting_key, setting_value, description, updated_at)
         VALUES ('platform_name', ?, 'Platform Brand Name displayed across web, scanner and print apps', NOW())
         ON DUPLICATE KEY UPDATE setting_value = ?, updated_at = NOW()`,
        [cleanName, cleanName]
      );

      await logAudit({
        userId: req.user?.id,
        userName: req.user?.name,
        action: 'UPDATE_SYSTEM_SETTINGS',
        entity: 'SYSTEM_SETTINGS',
        entityId: 'platform_name',
        newValue: { platform_name: cleanName },
        ipAddress,
        userAgent
      });
    }

    // Process any other key-values if sent
    for (const [key, value] of Object.entries(otherSettings)) {
      if (typeof value === 'string' || typeof value === 'number') {
        await query(
          `INSERT INTO system_settings (setting_key, setting_value, updated_at)
           VALUES (?, ?, NOW())
           ON DUPLICATE KEY UPDATE setting_value = ?, updated_at = NOW()`,
          [key, String(value), String(value)]
        );
      }
    }

    const rows = await query('SELECT setting_key, setting_value FROM system_settings');
    const updated = {};
    rows.forEach(r => {
      updated[r.setting_key] = r.setting_value;
    });

    res.json({
      success: true,
      message: 'System settings updated successfully',
      settings: updated
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getSystemSettings,
  updateSystemSettings
};
