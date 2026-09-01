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

    // Fetch user permissions
    const permissions = await query(
      `SELECT p.code FROM permissions p
       JOIN role_permissions rp ON p.id = rp.permission_id
       WHERE rp.role_id = ?`,
      [user.role_id]
    );

    req.user = {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role_name,
      roleId: user.role_id,
      eventId: user.event_id,
      eventName: user.event_name,
      eventCode: user.event_code,
      permissions: permissions.map(p => p.code)
    };

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
