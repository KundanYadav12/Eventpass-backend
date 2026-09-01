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
      const perms = await query(
        `SELECT p.code FROM permissions p
         JOIN role_permissions rp ON p.id = rp.permission_id
         WHERE rp.role_id = ?`,
        [user.role_id]
      );
      user.permissions = perms.map(p => p.code);
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
      return res.status(400).json({ success: false, message: 'Name, email, and password are required' });
    }

    const existing = await query('SELECT id FROM users WHERE email = ?', [email.trim().toLowerCase()]);
    if (existing.length > 0) {
      return res.status(400).json({ success: false, message: 'User with this email already exists' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const assignedEventId = roleId === 1 ? null : (eventId ? parseInt(eventId, 10) : null);

    const result = await query(
      `INSERT INTO users (name, email, password_hash, role_id, event_id, is_active, created_at)
       VALUES (?, ?, ?, ?, ?, 1, NOW())`,
      [name.trim(), email.trim().toLowerCase(), passwordHash, roleId, assignedEventId]
    );

    await logAudit({
      eventId: assignedEventId,
      userId: req.user?.id,
      userName: req.user?.name,
      action: 'CREATE_USER',
      entity: 'USER',
      entityId: result.insertId,
      newValue: { name, email, roleId, eventId: assignedEventId },
      ipAddress,
      userAgent
    });

    res.status(201).json({
      success: true,
      message: 'Admin account created successfully',
      data: { id: result.insertId, name, email, roleId, eventId: assignedEventId }
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

    const existing = await query('SELECT * FROM users WHERE id = ?', [id]);
    if (existing.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const oldUser = existing[0];
    let passwordHash = oldUser.password_hash;
    if (password && password.length >= 8) {
      passwordHash = await bcrypt.hash(password, 10);
    }

    const activeFlag = isActive !== undefined ? (isActive ? 1 : 0) : oldUser.is_active;
    const assignedEventId = roleId === 1 ? null : (eventId !== undefined ? eventId : oldUser.event_id);

    await query(
      `UPDATE users
       SET name = COALESCE(?, name),
           email = COALESCE(?, email),
           password_hash = ?,
           role_id = COALESCE(?, role_id),
           event_id = ?,
           is_active = ?,
           updated_at = NOW()
       WHERE id = ?`,
      [name, email ? email.trim().toLowerCase() : null, passwordHash, roleId, assignedEventId, activeFlag, id]
    );

    await logAudit({
      eventId: assignedEventId,
      userId: req.user?.id,
      userName: req.user?.name,
      action: 'UPDATE_USER',
      entity: 'USER',
      entityId: id,
      oldValue: { name: oldUser.name, email: oldUser.email, role_id: oldUser.role_id, event_id: oldUser.event_id, is_active: oldUser.is_active },
      newValue: { name, email, roleId, eventId: assignedEventId, isActive: activeFlag },
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

module.exports = {
  getUsers,
  createUser,
  updateUser,
  getRolesAndPermissions,
  updateRolePermissions
};
