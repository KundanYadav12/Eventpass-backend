const bcrypt = require('bcryptjs');
const { query, withTransaction } = require('../config/db');
const { logAudit } = require('../services/AuditService');
const salesReportService = require('../services/SalesReportService');

async function getUsers(req, res, next) {
  try {
    const isSuper = req.user?.role === 'SUPERADMIN' || req.user?.roleId === 1;
    const eventId = req.effectiveEventId || req.query.eventId;
    const whereConditions = [];
    const queryParams = [];

    if (eventId) {
      const parsedEvId = parseInt(eventId, 10);
      if (isSuper) {
        whereConditions.push(`(
          u.event_id = ?
          OR EXISTS (SELECT 1 FROM user_assigned_events uae WHERE uae.user_id = u.id AND uae.event_id = ?)
          OR EXISTS (SELECT 1 FROM admin_event_permissions aep WHERE aep.user_id = u.id AND aep.event_id = ?)
          OR u.role_id = 1
        )`);
        queryParams.push(parsedEvId, parsedEvId, parsedEvId);
      } else {
        whereConditions.push(`(
          u.event_id = ?
          OR EXISTS (SELECT 1 FROM user_assigned_events uae WHERE uae.user_id = u.id AND uae.event_id = ?)
          OR EXISTS (SELECT 1 FROM admin_event_permissions aep WHERE aep.user_id = u.id AND aep.event_id = ?)
        )`);
        queryParams.push(parsedEvId, parsedEvId, parsedEvId);
      }
    } else if (!isSuper) {
      // Event Admin called /users with no specific eventId: strictly isolate to their authorized event(s)
      whereConditions.push(`(
        u.event_id IN (
          SELECT event_id FROM user_assigned_events WHERE user_id = ?
          UNION SELECT event_id FROM admin_event_permissions WHERE user_id = ?
          ${req.user.eventId ? 'UNION SELECT ?' : ''}
        )
        OR EXISTS (
          SELECT 1 FROM user_assigned_events uae2 
          WHERE uae2.user_id = u.id AND uae2.event_id IN (
            SELECT event_id FROM user_assigned_events WHERE user_id = ?
            UNION SELECT event_id FROM admin_event_permissions WHERE user_id = ?
            ${req.user.eventId ? 'UNION SELECT ?' : ''}
          )
        )
      )`);
      queryParams.push(req.user.id, req.user.id);
      if (req.user.eventId) queryParams.push(req.user.eventId);
      queryParams.push(req.user.id, req.user.id);
      if (req.user.eventId) queryParams.push(req.user.eventId);
    }

    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

    const users = await query(
      `SELECT u.id, u.name, u.email, u.role_id, u.event_id, u.is_active, u.last_login_at, u.created_at,
              r.name as role_name, e.event_name
       FROM users u
       JOIN roles r ON u.role_id = r.id
       LEFT JOIN events e ON u.event_id = e.id
       ${whereClause}
       ORDER BY u.id ASC`,
      queryParams
    );

    for (const user of users) {
      // Fetch multi-event assignments
      const assignedEvs = await query(
        `SELECT uae.event_id, e.event_name, e.event_code
         FROM user_assigned_events uae
         JOIN events e ON uae.event_id = e.id
         WHERE uae.user_id = ?
         ORDER BY e.id ASC`,
        [user.id]
      );
      user.assignedEventIds = assignedEvs.map(ae => ae.event_id);
      user.assignedEvents = assignedEvs;
      if (user.event_id && !user.assignedEventIds.includes(user.event_id)) {
        user.assignedEventIds.push(user.event_id);
      }

      if (user.role_id === 1) {
        const allPerms = await query('SELECT code FROM permissions');
        user.permissions = allPerms.map(p => p.code);
      } else {
        const targetEvId = user.event_id || (eventId ? parseInt(eventId, 10) : null);
        if (targetEvId) {
          const perms = await query(
            `SELECT p.code FROM permissions p
             JOIN admin_event_permissions aep ON p.id = aep.permission_id
             WHERE aep.user_id = ? AND aep.event_id = ?`,
            [user.id, targetEvId]
          );
          if (perms && perms.length > 0) {
            user.permissions = perms.map(p => p.code);
          } else {
            // Fallback to role_permissions
            const rolePerms = await query(
              `SELECT p.code FROM permissions p
               JOIN role_permissions rp ON p.id = rp.permission_id
               WHERE rp.role_id = ?`,
              [user.role_id]
            );
            user.permissions = rolePerms.map(p => p.code);
          }
        } else {
          const rolePerms = await query(
            `SELECT p.code FROM permissions p
             JOIN role_permissions rp ON p.id = rp.permission_id
             WHERE rp.role_id = ?`,
            [user.role_id]
          );
          user.permissions = rolePerms.map(p => p.code);
        }
      }
    }

    res.json({
      success: true,
      data: users,
      users
    });
  } catch (error) {
    next(error);
  }
}

async function createUser(req, res, next) {
  try {
    const { name, email, password, roleId = 2, eventId = null, assignedEventIds = [] } = req.body;
    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'];
    const isSuper = req.user?.role === 'SUPERADMIN' || req.user?.roleId === 1;

    if (!name || !email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Name, email, and password are required'
      });
    }

    // Role-based validation: Non-SuperAdmin cannot create a SuperAdmin account
    if (!isSuper && parseInt(roleId, 10) === 1) {
      return res.status(403).json({
        success: false,
        message: 'Forbidden: Event Admins cannot create SuperAdmin accounts'
      });
    }

    // Check if email already exists
    const existing = await query('SELECT id FROM users WHERE email = ?', [email.toLowerCase().trim()]);
    if (existing.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'User with this email already exists'
      });
    }

    // Resolve primary eventId
    let primaryEventId = eventId ? parseInt(eventId, 10) : (assignedEventIds.length > 0 ? parseInt(assignedEventIds[0], 10) : null);

    // If non-SuperAdmin, enforce that the event is the user's authorized event
    if (!isSuper) {
      const authorizedEventId = req.effectiveEventId || req.user?.eventId;
      if (!authorizedEventId) {
        return res.status(403).json({
          success: false,
          message: 'Forbidden: No authorized event context found'
        });
      }
      primaryEventId = authorizedEventId;
    }

    // Role-based validation
    if (roleId !== 1 && !primaryEventId) {
      return res.status(400).json({
        success: false,
        message: 'At least one assigned event is required for this role'
      });
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    let newUserId;
    await withTransaction(async (conn) => {
      const [userRes] = await conn.query(
        `INSERT INTO users (name, email, password_hash, role_id, event_id, created_by, is_active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, NOW())`,
        [name.trim(), email.toLowerCase().trim(), passwordHash, roleId, roleId === 1 ? null : primaryEventId, req.user?.id || null]
      );
      newUserId = userRes.insertId;

      // Persist assigned events into user_assigned_events
      if (roleId !== 1) {
        const targetAssignedEvents = isSuper
          ? (Array.isArray(assignedEventIds) ? assignedEventIds.map(Number).filter(Boolean) : [])
          : [primaryEventId];

        const allEvIds = new Set([
          ...(primaryEventId ? [primaryEventId] : []),
          ...targetAssignedEvents
        ]);

        for (const evId of allEvIds) {
          await conn.query(
            'INSERT IGNORE INTO user_assigned_events (user_id, event_id) VALUES (?, ?)',
            [newUserId, evId]
          );
        }

        // Seed initial event permissions for each assigned event
        if (roleId === 2 || roleId === 4) {
          const [defaultRolePerms] = await conn.query('SELECT permission_id FROM role_permissions WHERE role_id = ?', [roleId]);
          for (const evId of allEvIds) {
            for (const rp of defaultRolePerms) {
              await conn.query(
                'INSERT IGNORE INTO admin_event_permissions (user_id, event_id, permission_id) VALUES (?, ?, ?)',
                [newUserId, evId, rp.permission_id]
              );
            }
          }
        }
      }
    });

    await logAudit({
      userId: req.user?.id,
      userName: req.user?.name,
      action: 'CREATE_USER',
      entity: 'USER',
      entityId: newUserId,
      newValue: { name, email, roleId, eventId: primaryEventId, assignedEventIds },
      ipAddress,
      userAgent
    });

    res.status(201).json({
      success: true,
      message: 'User created successfully',
      data: { id: newUserId, name, email, roleId, eventId: primaryEventId, assignedEventIds }
    });
  } catch (error) {
    next(error);
  }
}

async function updateUser(req, res, next) {
  try {
    const { id } = req.params;
    const { name, email, password, roleId, eventId, isActive, assignedEventIds } = req.body;
    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'];
    const isSuper = req.user?.role === 'SUPERADMIN' || req.user?.roleId === 1;

    const existingUsers = await query('SELECT * FROM users WHERE id = ?', [id]);
    if (existingUsers.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
    const existing = existingUsers[0];

    // Non-SuperAdmin validation: enforce event isolation and prevent privilege escalation
    let authorizedEventId = null;
    if (!isSuper) {
      if (existing.role_id === 1) {
        return res.status(403).json({
          success: false,
          message: 'Forbidden: Cannot edit SuperAdmin accounts'
        });
      }
      if (roleId !== undefined && parseInt(roleId, 10) === 1) {
        return res.status(403).json({
          success: false,
          message: 'Forbidden: Cannot promote user to SuperAdmin'
        });
      }
      authorizedEventId = req.effectiveEventId || req.user?.eventId;
      const userMatchesEvent = Number(existing.event_id) === Number(authorizedEventId) || (
        await query(
          'SELECT 1 FROM user_assigned_events WHERE user_id = ? AND event_id = ? LIMIT 1',
          [existing.id, authorizedEventId]
        )
      ).length > 0;

      if (!userMatchesEvent) {
        return res.status(403).json({
          success: false,
          message: 'Forbidden: You do not have permission to modify users from another event'
        });
      }
    }

    const updates = [];
    const params = [];

    if (name) { updates.push('name = ?'); params.push(name.trim()); }
    if (email) {
      const emailLower = email.toLowerCase().trim();
      if (emailLower !== existing.email) {
        const dupe = await query('SELECT id FROM users WHERE email = ? AND id != ?', [emailLower, id]);
        if (dupe.length > 0) {
          return res.status(409).json({ success: false, message: 'Email is already used by another account' });
        }
        updates.push('email = ?');
        params.push(emailLower);
      }
    }

    if (password && password.trim().length >= 8) {
      const salt = await bcrypt.genSalt(10);
      const passwordHash = await bcrypt.hash(password, salt);
      updates.push('password_hash = ?');
      params.push(passwordHash);
    }

    if (roleId !== undefined) {
      updates.push('role_id = ?');
      params.push(parseInt(roleId, 10));
    }

    let targetEventId = eventId;
    if (!isSuper && authorizedEventId) {
      targetEventId = authorizedEventId;
    } else if (targetEventId === undefined && Array.isArray(assignedEventIds) && assignedEventIds.length > 0) {
      targetEventId = assignedEventIds[0];
    }

    if (targetEventId !== undefined) {
      updates.push('event_id = ?');
      params.push((roleId === 1 || existing.role_id === 1) || !targetEventId ? null : parseInt(targetEventId, 10));
    }

    if (isActive !== undefined) {
      updates.push('is_active = ?');
      params.push(isActive ? 1 : 0);
    }

    if (updates.length > 0) {
      params.push(id);
      await query(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params);
    }

    // Sync assignedEventIds if supplied
    if (assignedEventIds !== undefined && Array.isArray(assignedEventIds)) {
      await query('DELETE FROM user_assigned_events WHERE user_id = ?', [id]);
      const validEvIds = !isSuper && authorizedEventId
        ? [authorizedEventId]
        : assignedEventIds.map(Number).filter(Boolean);
      for (const evId of validEvIds) {
        await query('INSERT IGNORE INTO user_assigned_events (user_id, event_id) VALUES (?, ?)', [id, evId]);
      }
      if (targetEventId && !validEvIds.includes(Number(targetEventId))) {
        await query('INSERT IGNORE INTO user_assigned_events (user_id, event_id) VALUES (?, ?)', [id, Number(targetEventId)]);
      }
    }

    await logAudit({
      userId: req.user?.id,
      userName: req.user?.name,
      action: 'UPDATE_USER',
      entity: 'USER',
      entityId: id,
      oldValue: existing,
      newValue: { name, email, roleId, eventId: targetEventId, isActive, assignedEventIds },
      ipAddress,
      userAgent
    });

    res.json({
      success: true,
      message: 'User updated successfully'
    });
  } catch (error) {
    next(error);
  }
}

async function getRolesAndPermissions(req, res, next) {
  try {
    const isSuper = req.user?.role === 'SUPERADMIN' || req.user?.roleId === 1;
    let roles = await query('SELECT * FROM roles ORDER BY id ASC');
    if (!isSuper) {
      roles = roles.filter(r => r.name !== 'SUPERADMIN' && r.id !== 1);
    }
    const permissions = await query('SELECT * FROM permissions ORDER BY module ASC, id ASC');
    const rolePermissions = await query('SELECT * FROM role_permissions');

    res.json({
      success: true,
      roles,
      permissions,
      rolePermissions
    });
  } catch (error) {
    next(error);
  }
}

async function updateRolePermissions(req, res, next) {
  try {
    const { roleId } = req.params;
    const { permissionIds = [] } = req.body;
    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'];

    await withTransaction(async (conn) => {
      await conn.query('DELETE FROM role_permissions WHERE role_id = ?', [roleId]);
      for (const pId of permissionIds) {
        await conn.query('INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)', [roleId, pId]);
      }
    });

    await logAudit({
      userId: req.user?.id,
      userName: req.user?.name,
      action: 'UPDATE_ROLE_PERMISSIONS',
      entity: 'ROLE',
      entityId: roleId,
      newValue: { permissionIds },
      ipAddress,
      userAgent
    });

    res.json({
      success: true,
      message: 'Role permissions updated successfully'
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Event-Scoped Permissions: GET /api/users/event-permissions?eventId=1&userId=2
 */
async function getEventPermissions(req, res, next) {
  try {
    const { eventId, userId } = req.query;
    if (!eventId) {
      return res.status(400).json({ success: false, message: 'Event ID is required' });
    }

    const targetEventId = parseInt(eventId, 10);
    let targetUserId = userId ? parseInt(userId, 10) : null;

    // If userId not given, fetch for the first active Event Admin or return all mapping
    let querySql = `
      SELECT aep.user_id, aep.event_id, aep.permission_id, p.code, p.name, p.module
      FROM admin_event_permissions aep
      JOIN permissions p ON aep.permission_id = p.id
      WHERE aep.event_id = ?
    `;
    const params = [targetEventId];

    if (targetUserId) {
      querySql += ' AND aep.user_id = ?';
      params.push(targetUserId);
    }

    const rows = await query(querySql, params);

    res.json({
      success: true,
      eventId: targetEventId,
      userId: targetUserId,
      permissionIds: rows.map(r => r.permission_id),
      permissionCodes: rows.map(r => r.code),
      details: rows
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Event-Scoped Permissions: PUT /api/users/event-permissions
 * Body: { eventId: 1, userId: 2 (or all admins for event), permissionIds: [1, 2, 3] }
 */
async function updateEventPermissions(req, res, next) {
  try {
    const { eventId, userId, permissionIds = [] } = req.body;
    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'];

    if (!eventId) {
      return res.status(400).json({ success: false, message: 'Event ID is required' });
    }

    const targetEventId = parseInt(eventId, 10);

    // Target specific user or all event admins for this event
    let targetUserIds = [];
    if (userId) {
      targetUserIds = [parseInt(userId, 10)];
    } else {
      const admins = await query('SELECT id FROM users WHERE role_id = 2 AND (event_id = ? OR event_id IS NULL)', [targetEventId]);
      targetUserIds = admins.map(a => a.id);
    }

    if (targetUserIds.length === 0) {
      // Find any event admin or create entry for role 2 admins
      const anyAdmins = await query('SELECT id FROM users WHERE role_id = 2');
      targetUserIds = anyAdmins.map(a => a.id);
    }

    await withTransaction(async (conn) => {
      for (const uId of targetUserIds) {
        await conn.query('DELETE FROM admin_event_permissions WHERE user_id = ? AND event_id = ?', [uId, targetEventId]);
        for (const pId of permissionIds) {
          await conn.query(
            'INSERT INTO admin_event_permissions (user_id, event_id, permission_id) VALUES (?, ?, ?)',
            [uId, targetEventId, pId]
          );
        }
      }
    });

    await logAudit({
      userId: req.user?.id,
      userName: req.user?.name,
      action: 'UPDATE_EVENT_PERMISSIONS',
      entity: 'EVENT_PERMISSIONS',
      entityId: targetEventId,
      newValue: { eventId: targetEventId, userIds: targetUserIds, permissionIds },
      ipAddress,
      userAgent
    });

    res.json({
      success: true,
      message: `Event #${targetEventId} permissions updated successfully for ${targetUserIds.length} admin account(s)`
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Scoped Cashier Accounts for Admin (Permission-Gated: cashiers.manage)
 * Admin sees only the cashiers they personally created.
 * SuperAdmin sees all cashiers (optionally filtered by eventId).
 */
async function getCashierAccounts(req, res, next) {
  try {
    const isSuper = req.user?.role === 'SUPERADMIN' || req.user?.roleId === 1;
    const eventId = req.effectiveEventId || req.query.eventId || null;

    let sql;
    let params;

    if (isSuper) {
      if (eventId) {
        sql = `
          SELECT u.id, u.name, u.email, u.role_id, u.event_id, u.created_by, u.is_active, u.last_login_at, u.created_at,
                 r.name as role_name, e.event_name, creator.name as creator_name, creator.email as creator_email
          FROM users u
          JOIN roles r ON u.role_id = r.id
          LEFT JOIN events e ON u.event_id = e.id
          LEFT JOIN users creator ON u.created_by = creator.id
          WHERE u.role_id = 3 AND (u.event_id = ? OR EXISTS (SELECT 1 FROM user_assigned_events uae WHERE uae.user_id = u.id AND uae.event_id = ?))
          ORDER BY u.id DESC
        `;
        params = [parseInt(eventId, 10), parseInt(eventId, 10)];
      } else {
        sql = `
          SELECT u.id, u.name, u.email, u.role_id, u.event_id, u.created_by, u.is_active, u.last_login_at, u.created_at,
                 r.name as role_name, e.event_name, creator.name as creator_name, creator.email as creator_email
          FROM users u
          JOIN roles r ON u.role_id = r.id
          LEFT JOIN events e ON u.event_id = e.id
          LEFT JOIN users creator ON u.created_by = creator.id
          WHERE u.role_id = 3
          ORDER BY u.id DESC
        `;
        params = [];
      }
    } else {
      // Non-SuperAdmin: strictly scoped to cashiers of the Admin's authorized event
      const authorizedEventId = req.effectiveEventId || req.user?.eventId;
      sql = `
        SELECT u.id, u.name, u.email, u.role_id, u.event_id, u.created_by, u.is_active, u.last_login_at, u.created_at,
               r.name as role_name, e.event_name, creator.name as creator_name, creator.email as creator_email
        FROM users u
        JOIN roles r ON u.role_id = r.id
        LEFT JOIN events e ON u.event_id = e.id
        LEFT JOIN users creator ON u.created_by = creator.id
        WHERE u.role_id = 3 AND (u.event_id = ? OR EXISTS (SELECT 1 FROM user_assigned_events uae WHERE uae.user_id = u.id AND uae.event_id = ?))
        ORDER BY u.id DESC
      `;
      params = [parseInt(authorizedEventId, 10), parseInt(authorizedEventId, 10)];
    }

    const cashiers = await query(sql, params);
    res.json({
      success: true,
      data: cashiers,
      cashiers
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Create a new Cashier account from the Cashier Accounts tab
 * Strictly scoped: Admin can only create CASHIER (role_id: 3) for their authorized event.
 * SuperAdmin can create CASHIER for any event.
 */
async function createCashierAccount(req, res, next) {
  try {
    const { name, email, password } = req.body;
    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'];
    const isSuper = req.user?.role === 'SUPERADMIN' || req.user?.roleId === 1;

    if (!name || !email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Name, email, and password are required'
      });
    }

    // Role is strictly locked to CASHIER (role_id = 3)
    const roleId = 3;

    // Check if email already exists
    const existing = await query('SELECT id FROM users WHERE email = ?', [email.toLowerCase().trim()]);
    if (existing.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'User with this email already exists'
      });
    }

    // Determine target event
    let targetEventId = req.effectiveEventId || req.user?.eventId;
    if (isSuper && req.body.eventId) {
      targetEventId = parseInt(req.body.eventId, 10);
    }

    if (!targetEventId) {
      return res.status(400).json({
        success: false,
        message: 'An assigned event is required for creating a Cashier'
      });
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    let newUserId;
    await withTransaction(async (conn) => {
      const [userRes] = await conn.query(
        `INSERT INTO users (name, email, password_hash, role_id, event_id, created_by, is_active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, NOW())`,
        [name.trim(), email.toLowerCase().trim(), passwordHash, roleId, targetEventId, req.user.id]
      );
      newUserId = userRes.insertId;

      // Assign to user_assigned_events
      await conn.query(
        'INSERT IGNORE INTO user_assigned_events (user_id, event_id) VALUES (?, ?)',
        [newUserId, targetEventId]
      );

      // Seed default cashier permissions (cashier.sell, cashier.view_own_sales) in admin_event_permissions
      const [cashierPerms] = await conn.query(
        "SELECT id FROM permissions WHERE code IN ('cashier.sell', 'cashier.view_own_sales')"
      );
      if (cashierPerms && cashierPerms.length > 0) {
        for (const p of cashierPerms) {
          await conn.query(
            'INSERT IGNORE INTO admin_event_permissions (user_id, event_id, permission_id) VALUES (?, ?, ?)',
            [newUserId, targetEventId, p.id]
          );
        }
      }
    });

    await logAudit({
      userId: req.user?.id,
      userName: req.user?.name,
      action: 'CREATE_CASHIER_ACCOUNT',
      entity: 'USER',
      entityId: newUserId,
      newValue: { name, email, roleId: 3, eventId: targetEventId, createdBy: req.user.id },
      ipAddress,
      userAgent
    });

    res.status(201).json({
      success: true,
      message: 'Cashier account created successfully',
      data: {
        id: newUserId,
        name: name.trim(),
        email: email.toLowerCase().trim(),
        roleId: 3,
        role_name: 'CASHIER',
        eventId: targetEventId,
        created_by: req.user.id
      }
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Update a Cashier account (Permission-Gated: cashiers.manage)
 * Event Admin can edit cashiers belonging to their authorized event.
 * SuperAdmin can edit any cashier across any event.
 */
async function updateCashierAccount(req, res, next) {
  try {
    const { id } = req.params;
    const { name, email, password, isActive, eventId } = req.body;
    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'];
    const isSuper = req.user?.role === 'SUPERADMIN' || req.user?.roleId === 1;

    const existingUsers = await query(
      `SELECT u.*, e.event_name 
       FROM users u 
       LEFT JOIN events e ON u.event_id = e.id 
       WHERE u.id = ?`,
      [id]
    );

    if (existingUsers.length === 0 || existingUsers[0].role_id !== 3) {
      return res.status(404).json({
        success: false,
        message: 'Cashier account not found'
      });
    }

    const existing = existingUsers[0];

    // Non-SuperAdmin validation: strictly enforce event isolation
    if (!isSuper) {
      const authorizedEventId = req.effectiveEventId || req.user?.eventId;
      const cashierMatchesEvent = Number(existing.event_id) === Number(authorizedEventId) || (
        await query(
          'SELECT 1 FROM user_assigned_events WHERE user_id = ? AND event_id = ? LIMIT 1',
          [existing.id, authorizedEventId]
        )
      ).length > 0;

      if (!cashierMatchesEvent) {
        return res.status(403).json({
          success: false,
          message: 'Forbidden: You do not have permission to modify cashiers from another event'
        });
      }
    }

    const updates = [];
    const params = [];

    if (name && name.trim()) {
      updates.push('name = ?');
      params.push(name.trim());
    }

    if (email) {
      const emailLower = email.toLowerCase().trim();
      if (emailLower !== existing.email) {
        const dupe = await query('SELECT id FROM users WHERE email = ? AND id != ?', [emailLower, id]);
        if (dupe.length > 0) {
          return res.status(409).json({ success: false, message: 'Email is already used by another account' });
        }
        updates.push('email = ?');
        params.push(emailLower);
      }
    }

    if (password && password.trim().length >= 6) {
      const salt = await bcrypt.genSalt(10);
      const passwordHash = await bcrypt.hash(password, salt);
      updates.push('password_hash = ?');
      params.push(passwordHash);
    }

    if (isActive !== undefined) {
      updates.push('is_active = ?');
      params.push(isActive ? 1 : 0);
    }

    // SuperAdmin can reassign event if specified
    if (isSuper && eventId !== undefined) {
      const parsedEvId = parseInt(eventId, 10);
      updates.push('event_id = ?');
      params.push(parsedEvId);

      // Also update user_assigned_events
      await query('DELETE FROM user_assigned_events WHERE user_id = ?', [id]);
      await query('INSERT INTO user_assigned_events (user_id, event_id) VALUES (?, ?)', [id, parsedEvId]);
    }

    if (updates.length > 0) {
      params.push(id);
      await query(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params);
    }

    await logAudit({
      userId: req.user?.id,
      userName: req.user?.name,
      action: 'UPDATE_CASHIER_ACCOUNT',
      entity: 'USER',
      entityId: id,
      newValue: { name, email, isActive, eventId: isSuper && eventId ? eventId : existing.event_id },
      ipAddress,
      userAgent
    });

    const [updatedUser] = await query(
      `SELECT u.id, u.name, u.email, u.role_id, u.event_id, u.created_by, u.is_active, u.last_login_at, u.created_at,
              r.name as role_name, e.event_name
       FROM users u
       JOIN roles r ON u.role_id = r.id
       LEFT JOIN events e ON u.event_id = e.id
       WHERE u.id = ?`,
      [id]
    );

    res.json({
      success: true,
      message: 'Cashier account updated successfully',
      data: updatedUser
    });
  } catch (error) {
    next(error);
  }
}

/**
 * View individual sales report for a specific cashier
 * Scoped: Admin can view report for any cashier belonging to their authorized event.
 * SuperAdmin can view report for any cashier across all events.
 */
async function getCashierSalesReport(req, res, next) {
  try {
    const { id } = req.params;
    const isSuper = req.user?.role === 'SUPERADMIN' || req.user?.roleId === 1;

    const cashiers = await query(
      `SELECT u.id, u.name, u.email, u.role_id, u.event_id, u.created_by, e.event_name
       FROM users u
       LEFT JOIN events e ON u.event_id = e.id
       WHERE u.id = ?`,
      [id]
    );

    if (cashiers.length === 0 || cashiers[0].role_id !== 3) {
      return res.status(404).json({
        success: false,
        message: 'Cashier account not found'
      });
    }

    const cashier = cashiers[0];

    // Non-SuperAdmin must belong to this cashier's event
    if (!isSuper) {
      const authorizedEventId = req.effectiveEventId || req.user?.eventId;
      const belongsToEvent = Number(cashier.event_id) === Number(authorizedEventId) || (
        await query(
          'SELECT 1 FROM user_assigned_events WHERE user_id = ? AND event_id = ? LIMIT 1',
          [cashier.id, authorizedEventId]
        )
      ).length > 0;

      if (!belongsToEvent) {
        return res.status(403).json({
          success: false,
          message: 'Forbidden: You can only view sales reports for cashier accounts belonging to your authorized event'
        });
      }
    }

    const filterParams = {
      ...req.query,
      eventId: cashier.event_id,
      createdBy: cashier.id
    };

    const summary = await salesReportService.getSalesSummary(filterParams);
    const txResult = await salesReportService.getSalesTransactions(filterParams);

    res.json({
      success: true,
      cashier: {
        id: cashier.id,
        name: cashier.name,
        email: cashier.email,
        eventId: cashier.event_id,
        eventName: cashier.event_name
      },
      summary,
      transactions: txResult.transactions || [],
      pagination: txResult.pagination || { total: 0, page: 1, limit: 20, totalPages: 0 }
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getUsers,
  createUser,
  updateUser,
  getRolesAndPermissions,
  updateRolePermissions,
  getEventPermissions,
  updateEventPermissions,
  getCashierAccounts,
  createCashierAccount,
  updateCashierAccount,
  getCashierSalesReport
};
