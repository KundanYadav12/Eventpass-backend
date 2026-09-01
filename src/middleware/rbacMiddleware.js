/**
 * Role-Based Access Control (RBAC) & Event Scope Middleware
 */

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

function requirePermission(permissionCode) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required'
      });
    }

    // SuperAdmin has all permissions
    if (req.user.role === 'SUPERADMIN') {
      return next();
    }

    if (req.user.permissions && req.user.permissions.includes(permissionCode)) {
      return next();
    }

    return res.status(403).json({
      success: false,
      message: `Forbidden: Permission '${permissionCode}' required`
    });
  };
}

/**
 * Event Scoping Middleware:
 * If user is SUPERADMIN:
 *   - Allows passing `eventId` via query, body, or params.
 *   - If no `eventId` is provided, allows global multi-event view.
 * If user is ADMIN:
 *   - Automatically locks `req.effectiveEventId = req.user.eventId`.
 *   - If requested `eventId` or target record's event differs from `req.user.eventId`, returns 403 Forbidden.
 */
function scopeEventAccess(req, res, next) {
  if (!req.user) {
    req.effectiveEventId = null;
    return next();
  }

  if (req.user.role === 'SUPERADMIN') {
    const requestedEventId = req.query.eventId || req.body?.eventId || req.params?.eventId || null;
    req.effectiveEventId = requestedEventId ? parseInt(requestedEventId, 10) : null;
    return next();
  }

  // Admin user
  const adminEventId = req.user.eventId;
  if (!adminEventId) {
    return res.status(403).json({
      success: false,
      message: 'Admin user is not assigned to any active event.'
    });
  }

  const requestedEventId = req.query.eventId || req.body?.eventId || req.params?.eventId;
  if (requestedEventId && parseInt(requestedEventId, 10) !== adminEventId) {
    return res.status(403).json({
      success: false,
      message: 'Forbidden: You do not have permission to access data from another event.'
    });
  }

  req.effectiveEventId = adminEventId;
  // Overwrite query/body eventId to guarantee backend isolation
  if (req.query) req.query.eventId = adminEventId;
  if (req.body && typeof req.body === 'object') req.body.eventId = adminEventId;

  next();
}

module.exports = {
  requireRole,
  requirePermission,
  scopeEventAccess
};
