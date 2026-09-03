/**
 * Role-Based Access Control (RBAC) & Strict Event-Scoped Permissions Middleware
 */
const { query } = require('../config/db');

function requireRole(allowedRoles) {
  const roles = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];

  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required'
      });
    }

    // SuperAdmin always has full access
    if (req.user.role === 'SUPERADMIN') {
      return next();
    }

    if (roles.includes(req.user.role)) {
      return next();
    }

    return res.status(403).json({
      success: false,
      message: 'Forbidden: Insufficient privileges for this action'
    });
  };
}

/**
 * Validates that the logged-in user possesses the required permission(s)
 * specifically for the active/target event context.
 * Accepts a single permission code (string) or multiple codes (array - any match allows access).
 */
function requirePermission(permissionCode) {
  const codes = Array.isArray(permissionCode) ? permissionCode : [permissionCode];

  return async (req, res, next) => {
    try {
      if (!req.user) {
        return res.status(401).json({
          success: false,
          message: 'Authentication required'
        });
      }

      // 1. SuperAdmin has global unrestricted permissions across all events
      if (req.user.role === 'SUPERADMIN') {
        return next();
      }

      // 2. Identify the target event for this operation
      const targetEventId = req.effectiveEventId || req.query?.eventId || req.body?.eventId || req.params?.eventId || req.user?.eventId;

      if (!targetEventId) {
        return res.status(403).json({
          success: false,
          message: `Forbidden: Target event required to validate permission '${codes.join(' or ')}'`
        });
      }

      const parsedEventId = parseInt(targetEventId, 10);

      // 3. Query the event-specific permissions table
      const placeholders = codes.map(() => '?').join(',');
      const rows = await query(
        `SELECT aep.id
         FROM admin_event_permissions aep
         JOIN permissions p ON aep.permission_id = p.id
         WHERE aep.user_id = ? AND aep.event_id = ? AND p.code IN (${placeholders})`,
        [req.user.id, parsedEventId, ...codes]
      );

      if (rows && rows.length > 0) {
        return next();
      }

      return res.status(403).json({
        success: false,
        message: `Forbidden: Permission '${codes.join(' or ')}' is not granted for Event #${parsedEventId}`
      });
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Event Scoping Middleware:
 * If user is SUPERADMIN:
 *   - Allows passing `eventId` via query, body, or params.
 *   - If no `eventId` is provided, allows global multi-event view.
 * If user is ADMIN:
 *   - Allows accessing requested event if assigned or granted event permissions.
 *   - Rejects with 403 if admin has no affiliation or permissions for that event.
 */
async function scopeEventAccess(req, res, next) {
  try {
    if (!req.user) {
      req.effectiveEventId = null;
      return next();
    }

    if (req.user.role === 'SUPERADMIN') {
      const requestedEventId = req.query?.eventId || req.body?.eventId || req.params?.eventId || null;
      req.effectiveEventId = requestedEventId ? parseInt(requestedEventId, 10) : null;
      return next();
    }

    // Admin user
    const requestedEventId = req.query?.eventId || req.body?.eventId || req.params?.eventId;
    const targetEventId = requestedEventId ? parseInt(requestedEventId, 10) : (req.user.eventId || 1);

    // 1. Direct match with user's primary assigned event
    if (req.user.eventId === targetEventId) {
      req.effectiveEventId = targetEventId;
      if (req.query) req.query.eventId = targetEventId;
      if (req.body && typeof req.body === 'object') req.body.eventId = targetEventId;
      return next();
    }

    // 2. Check if admin has event-scoped permissions registered for this event
    const activePerms = await query(
      'SELECT id FROM admin_event_permissions WHERE user_id = ? AND event_id = ? LIMIT 1',
      [req.user.id, targetEventId]
    );

    if (activePerms && activePerms.length > 0) {
      req.effectiveEventId = targetEventId;
      if (req.query) req.query.eventId = targetEventId;
      if (req.body && typeof req.body === 'object') req.body.eventId = targetEventId;
      return next();
    }

    return res.status(403).json({
      success: false,
      message: 'Forbidden: You do not have permission to access data from another event.'
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  requireRole,
  requirePermission,
  scopeEventAccess
};
