const bcrypt = require('bcryptjs');
const { query, withTransaction } = require('../config/db');
const { logAudit } = require('../services/AuditService');

async function getUsers(req, res, next) {
  try {
    const eventId = req.effectiveEventId || req.query.eventId;
    const whereConditions = [];
    const queryParams = [];

    if (eventId) {
      whereConditions.push('(u.event_id = ? OR u.role_id = 1)');
      queryParams.push(parseInt(eventId, 10));
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
      data: users
    });
  } catch (error) {
    next(error);
  }
}

async function createUser(req, res, next) {
  try {
    const { name, email, password, roleId = 2, eventId = null } = req.body;
    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'];

    if (!name || !email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Name, email, and password are required'
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

    // Role-based validation
    if (roleId !== 1 && !eventId) {
      return res.status(400).json({
        success: false,
        message: 'Assigned event is required for Event Admin role'
      });
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    let newUserId;
    await withTransaction(async (conn) => {
      const [userRes] = await conn.query(
        `INSERT INTO users (name, email, password_hash, role_id, event_id, is_active, created_at)
         VALUES (?, ?, ?, ?, ?, 1, NOW())`,
        [name.trim(), email.toLowerCase().trim(), passwordHash, roleId, roleId === 1 ? null : parseInt(eventId, 10)]
      );
      newUserId = userRes.insertId;

      // Seed initial event permissions for this admin if event assigned
      if (roleId === 2 && eventId) {
        const [defaultRolePerms] = await conn.query('SELECT permission_id FROM role_permissions WHERE role_id = 2');
        for (const rp of defaultRolePerms) {
          await conn.query(
            'INSERT IGNORE INTO admin_event_permissions (user_id, event_id, permission_id) VALUES (?, ?, ?)',
            [newUserId, parseInt(eventId, 10), rp.permission_id]
          );
        }
      }
    });

    await logAudit({
      userId: req.user?.id,
      userName: req.user?.name,
      action: 'CREATE_USER',
      entity: 'USER',
      entityId: newUserId,
      newValue: { name, email, roleId, eventId },
      ipAddress,
      userAgent
    });

    res.status(201).json({
      success: true,
      message: 'User created successfully',
      data: { id: newUserId, name, email, roleId, eventId }
    });
  } catch (error) {
    next(error);
  }
}

async function updateUser(req, res, next) {
  try {
    const { id } = req.params;
    const { name, email, password, roleId, eventId, isActive } = req.body;
    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'];

    const existingUsers = await query('SELECT * FROM users WHERE id = ?', [id]);
    if (existingUsers.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
    const existing = existingUsers[0];

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

    if (eventId !== undefined) {
      updates.push('event_id = ?');
      params.push(roleId === 1 || !eventId ? null : parseInt(eventId, 10));
    }

    if (isActive !== undefined) {
      updates.push('is_active = ?');
      params.push(isActive ? 1 : 0);
    }

    if (updates.length > 0) {
      params.push(id);
      await query(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params);
    }

    await logAudit({
      userId: req.user?.id,
      userName: req.user?.name,
      action: 'UPDATE_USER',
      entity: 'USER',
      entityId: id,
      oldValue: existing,
      newValue: { name, email, roleId, eventId, isActive },
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
    const roles = await query('SELECT * FROM roles ORDER BY id ASC');
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

module.exports = {
  getUsers,
  createUser,
  updateUser,
  getRolesAndPermissions,
  updateRolePermissions,
  getEventPermissions,
  updateEventPermissions
};
