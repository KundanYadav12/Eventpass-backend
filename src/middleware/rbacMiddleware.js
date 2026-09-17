/**
 * Role-Based Access Control (RBAC) & Strict Event-Scoped Permissions Middleware
 */
const { query } = require('../config/db');

function isSuperAdminUser(user) {
  if (!user) return false;
  const roleName = String(user.role || '').toUpperCase();
  return roleName === 'SUPERADMIN' || user.roleId === 1;
}

function requireRole(allowedRoles) {
  const roles = (Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles]).map(r => String(r).toUpperCase());

  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required'
      });
    }

    // SuperAdmin always has full access
    if (isSuperAdminUser(req.user)) {
      return next();
    }

    const userRole = String(req.user.role || '').toUpperCase();
    if (roles.includes(userRole)) {
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
      if (isSuperAdminUser(req.user)) {
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

      // 4. Check if user is assigned to this event via primary event or user_assigned_events
      let isAssigned = Number(req.user.eventId) === parsedEventId;
      if (!isAssigned && req.user.id) {
        const assignedRows = await query(
          'SELECT id FROM user_assigned_events WHERE user_id = ? AND event_id = ? LIMIT 1',
          [req.user.id, parsedEventId]
        );
        isAssigned = assignedRows && assignedRows.length > 0;
      }

      // Fallback to role_permissions if user is assigned to this event
      if (isAssigned || !req.user.eventId) {
        const rolePermRows = await query(
          `SELECT rp.role_id
           FROM role_permissions rp
           JOIN permissions p ON rp.permission_id = p.id
           WHERE rp.role_id = ? AND p.code IN (${placeholders})`,
          [req.user.roleId, ...codes]
        );
        if (rolePermRows && rolePermRows.length > 0) {
          return next();
        }
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
 * If user is ADMIN / CASHIER / Non-SuperAdmin:
 *   - Resolves target event and verifies assignment or explicit permissions.
 *   - Checks primary assigned event, user_assigned_events, and admin_event_permissions.
 *   - Rejects with 403 only if user has no authorization for the requested event.
 */
async function scopeEventAccess(req, res, next) {
  try {
    if (!req.user) {
      req.effectiveEventId = null;
      return next();
    }

    // SuperAdmin always has full access to any requested event or global multi-event view
    if (isSuperAdminUser(req.user)) {
      const requestedEventId = req.query?.eventId || req.body?.eventId || req.params?.eventId || null;
      req.effectiveEventId = requestedEventId ? parseInt(requestedEventId, 10) : null;
      return next();
    }

    // Event-scoped user (ADMIN, CASHIER, etc.)
    const requestedEventId = req.query?.eventId || req.body?.eventId || req.params?.eventId;
    let targetEventId = requestedEventId ? parseInt(requestedEventId, 10) : null;

    // If no specific event was requested, determine user's default active event
    if (!targetEventId) {
      if (req.user.eventId) {
        targetEventId = parseInt(req.user.eventId, 10);
      } else {
        const assignedEv = await query(
          `SELECT event_id FROM user_assigned_events WHERE user_id = ? 
           UNION 
           SELECT event_id FROM admin_event_permissions WHERE user_id = ? 
           LIMIT 1`,
          [req.user.id, req.user.id]
        );
        if (assignedEv && assignedEv.length > 0) {
          targetEventId = parseInt(assignedEv[0].event_id, 10);
        } else {
          // User has no assigned events yet
          req.effectiveEventId = null;
          return next();
        }
      }
    }

    // 1. Direct match with user's primary assigned event
    if (req.user.eventId && Number(req.user.eventId) === Number(targetEventId)) {
      req.effectiveEventId = targetEventId;
      if (req.query) req.query.eventId = targetEventId;
      if (req.body && typeof req.body === 'object') req.body.eventId = targetEventId;
      return next();
    }

    // 2. Check multi-event assignments in user_assigned_events table
    const assignedRow = await query(
      'SELECT id FROM user_assigned_events WHERE user_id = ? AND event_id = ? LIMIT 1',
      [req.user.id, targetEventId]
    );
    if (assignedRow && assignedRow.length > 0) {
      req.effectiveEventId = targetEventId;
      if (req.query) req.query.eventId = targetEventId;
      if (req.body && typeof req.body === 'object') req.body.eventId = targetEventId;
      return next();
    }

    // 3. Check if admin has event-scoped permissions registered for this event
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

    // Explicitly requested an event that the user has no permissions or assignment for
    return res.status(403).json({
      success: false,
      message: 'Forbidden: You do not have permission to access data from another event.'
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Middleware that strictly confines SCANNER accounts to gate scanning operations.
 * Any attempt by a SCANNER account to access non-scanner routes (dashboard, passes, categories,
 * billing, sales, users, settings, database, etc.) is rejected with 403 Forbidden.
 */
function enforceScannerScope(req, res, next) {
  if (!req.user) return next();

  const userRole = String(req.user.role || '').toUpperCase();
  const isScanner = userRole === 'SCANNER' || req.user.roleId === 4;

  if (!isScanner) return next();

  // Allow only scanner-relevant paths
  const path = req.path || req.originalUrl || '';

  const isAllowed =
    path.startsWith('/scan') ||
    path.startsWith('/checkpoints') ||
    path.startsWith('/events') ||
    path.startsWith('/gates') ||
    path.startsWith('/auth') ||
    path.startsWith('/profile') ||
    path === '/health';

  if (isAllowed) {
    // Furthermore, enforce that if an eventId is provided, it MUST match the scanner's assigned event
    if (req.user.eventId) {
      req.effectiveEventId = req.user.eventId;
      if (req.query) req.query.eventId = req.user.eventId;
      if (req.body && typeof req.body === 'object') {
        req.body.targetEventId = req.user.eventId;
        req.body.eventId = req.user.eventId;
      }
    }
    return next();
  }

  return res.status(403).json({
    success: false,
    message: 'Forbidden: Scanner accounts are strictly restricted to the scanning system.'
  });
}

module.exports = {
  isSuperAdminUser,
  requireRole,
  requirePermission,
  scopeEventAccess,
  enforceScannerScope
};

