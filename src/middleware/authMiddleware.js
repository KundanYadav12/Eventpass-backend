const { verifyAccessToken } = require('../config/jwt');
const { query } = require('../config/db');

async function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.substring(7) : null;

  if (!token) {
    return res.status(401).json({
      success: false,
      message: 'Authentication token required'
    });
  }

  const { valid, payload, error } = verifyAccessToken(token);
  if (!valid) {
    return res.status(401).json({
      success: false,
      message: 'Invalid or expired access token',
      error
    });
  }

  try {
    // Fetch user details with role, active status, and assigned event
    const users = await query(
      `SELECT u.id, u.name, u.email, u.role_id, u.event_id, u.is_active,
              r.name as role_name, e.event_name, e.event_code
       FROM users u
       JOIN roles r ON u.role_id = r.id
       LEFT JOIN events e ON u.event_id = e.id
       WHERE u.id = ? LIMIT 1`,
      [payload.userId]
    );

    if (users.length === 0 || !users[0].is_active) {
      return res.status(403).json({
        success: false,
        message: 'User account is deactivated or not found'
      });
    }

    const user = users[0];

    // Fetch event-scoped permissions map: { [eventId]: [code1, code2, ...] }
    const eventPermissionsMap = {};
    if (user.role_name === 'SUPERADMIN') {
      const allPerms = await query('SELECT code FROM permissions');
      const allCodes = allPerms.map(p => p.code);
      // SuperAdmin has all permissions globally
      req.user = {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role_name,
        roleId: user.role_id,
        eventId: user.event_id,
        eventName: user.event_name,
        eventCode: user.event_code,
        permissions: allCodes,
        eventPermissions: {}
      };
    } else {
      const eventPermRows = await query(
        `SELECT aep.event_id, p.code
         FROM admin_event_permissions aep
         JOIN permissions p ON aep.permission_id = p.id
         WHERE aep.user_id = ?`,
        [user.id]
      );

      for (const row of eventPermRows) {
        if (!eventPermissionsMap[row.event_id]) {
          eventPermissionsMap[row.event_id] = [];
        }
        eventPermissionsMap[row.event_id].push(row.code);
      }

      // Default permissions for user's assigned event or fallback to role_permissions
      let defaultPerms = user.event_id && eventPermissionsMap[user.event_id] ? eventPermissionsMap[user.event_id] : [];
      if (defaultPerms.length === 0) {
        const rolePerms = await query(
          `SELECT p.code FROM permissions p
           JOIN role_permissions rp ON p.id = rp.permission_id
           WHERE rp.role_id = ?`,
          [user.role_id]
        );
        defaultPerms = rolePerms.map(p => p.code);
      }

      req.user = {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role_name,
        roleId: user.role_id,
        eventId: user.event_id,
        eventName: user.event_name,
        eventCode: user.event_code,
        permissions: defaultPerms,
        eventPermissions: eventPermissionsMap
      };
    }

    next();
  } catch (err) {
    console.error('[Auth Middleware Error]:', err.message);
    return res.status(500).json({
      success: false,
      message: 'Internal server error during authentication'
    });
  }
}

// Optional auth (doesn't fail if no token, but attaches user if token is present)
async function optionalAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.substring(7) : null;

  if (!token) {
    req.user = null;
    return next();
  }

  const { valid, payload } = verifyAccessToken(token);
  if (valid && payload) {
    try {
      const users = await query(
        `SELECT u.id, u.name, u.email, u.role_id, u.event_id, r.name as role_name, e.event_name
         FROM users u
         JOIN roles r ON u.role_id = r.id
         LEFT JOIN events e ON u.event_id = e.id
         WHERE u.id = ? AND u.is_active = 1`,
        [payload.userId]
      );
      if (users.length > 0) {
        req.user = {
          id: users[0].id,
          name: users[0].name,
          email: users[0].email,
          role: users[0].role_name,
          roleId: users[0].role_id,
          eventId: users[0].event_id,
          eventName: users[0].event_name
        };
      }
    } catch (e) {
      // Ignore
    }
  }
  next();
}

module.exports = {
  authenticateToken,
  optionalAuth
};
