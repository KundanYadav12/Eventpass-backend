const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { query } = require('../config/db');
const { generateAccessToken, generateRefreshToken, verifyRefreshToken } = require('../config/jwt');
const { sendEmail } = require('../config/email');
const { logAudit } = require('../services/AuditService');

async function getUserPermissionsPayload(user) {
  if (user.role_name === 'SUPERADMIN' || user.role_id === 1) {
    const allPerms = await query('SELECT code FROM permissions');
    const allCodes = allPerms.map(p => p.code);
    return {
      permissions: allCodes,
      eventPermissions: {}
    };
  }

  const eventPermissionsMap = {};
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

  return {
    permissions: defaultPerms,
    eventPermissions: eventPermissionsMap
  };
}

/**
 * User Login (SuperAdmin & Admin)
 */
async function login(req, res, next) {
  try {
    const { email, password } = req.body;
    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'];

    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password are required' });
    }

    const users = await query(
      `SELECT u.*, r.name as role_name, e.event_name, e.event_code
       FROM users u
       JOIN roles r ON u.role_id = r.id
       LEFT JOIN events e ON u.event_id = e.id
       WHERE u.email = ? LIMIT 1`,
      [email.trim().toLowerCase()]
    );

    if (users.length === 0) {
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    }

    const user = users[0];

    if (!user.is_active) {
      return res.status(403).json({ success: false, message: 'Account is deactivated. Contact SuperAdmin.' });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    }

    // Fetch user permissions
    const permData = await getUserPermissionsPayload(user);

    // Update last login
    await query('UPDATE users SET last_login_at = NOW() WHERE id = ?', [user.id]);

    const tokenPayload = {
      userId: user.id,
      email: user.email,
      role: user.role_name,
      eventId: user.event_id
    };

    const accessToken = generateAccessToken(tokenPayload);
    const refreshToken = generateRefreshToken(tokenPayload);

    await logAudit({
      userId: user.id,
      userName: user.name,
      action: 'LOGIN',
      entity: 'USER',
      entityId: user.id,
      ipAddress,
      userAgent
    });

    res.json({
      success: true,
      message: 'Login successful',
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role_name,
        roleId: user.role_id,
        eventId: user.event_id,
        eventName: user.event_name,
        eventCode: user.event_code,
        assignedEvent: user.event_id ? { id: user.event_id, name: user.event_name, code: user.event_code } : null,
        permissions: permData.permissions,
        eventPermissions: permData.eventPermissions
      }
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Refresh Access Token
 */
async function refreshToken(req, res, next) {
  try {
    const { refreshToken: token } = req.body;
    if (!token) {
      return res.status(400).json({ success: false, message: 'Refresh token required' });
    }

    const { valid, payload, error } = verifyRefreshToken(token);
    if (!valid) {
      return res.status(401).json({ success: false, message: 'Invalid or expired refresh token', error });
    }

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
      return res.status(403).json({ success: false, message: 'User inactive or not found' });
    }

    const user = users[0];

    const tokenPayload = {
      userId: user.id,
      email: user.email,
      role: user.role_name,
      eventId: user.event_id
    };

    const newAccessToken = generateAccessToken(tokenPayload);
    const newRefreshToken = generateRefreshToken(tokenPayload);

    // Fetch user permissions
    const permData = await getUserPermissionsPayload(user);

    res.json({
      success: true,
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role_name,
        roleId: user.role_id,
        eventId: user.event_id,
        eventName: user.event_name,
        eventCode: user.event_code,
        assignedEvent: user.event_id ? { id: user.event_id, name: user.event_name, code: user.event_code } : null,
        permissions: permData.permissions,
        eventPermissions: permData.eventPermissions
      }
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Get current authenticated user profile
 */
async function getMe(req, res, next) {
  try {
    res.json({
      success: true,
      user: req.user
    });
  } catch (error) {
    next(error);
  }
}

/**
 * User Logout (Audit Log)
 */
async function logout(req, res, next) {
  try {
    if (req.user) {
      await logAudit({
        userId: req.user.id,
        userName: req.user.name,
        action: 'LOGOUT',
        entity: 'USER',
        entityId: req.user.id,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent']
      });
    }
    res.json({ success: true, message: 'Logged out successfully' });
  } catch (error) {
    next(error);
  }
}

/**
 * Request Password Reset
 */
async function forgotPassword(req, res, next) {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ success: false, message: 'Email is required' });
    }

    const users = await query('SELECT id, name, email FROM users WHERE email = ? AND is_active = 1', [email.trim().toLowerCase()]);
    
    // Always return success to prevent email enumeration attacks
    if (users.length === 0) {
      return res.json({ success: true, message: 'If the email exists, a password reset link has been sent.' });
    }

    const user = users[0];
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour expiry

    // Save reset token
    await query(
      `INSERT INTO password_resets (user_id, token_hash, expires_at, created_at)
       VALUES (?, ?, ?, NOW())`,
      [user.id, tokenHash, expiresAt]
    );

    // Dynamically resolve frontend base URL (supporting managemyshow.com and eventgen.duckdns.org)
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    const host = req.headers['x-forwarded-host'] || req.get('host');
    const defaultFrontend = process.env.FRONTEND_URL || 'https://managemyshow.com';
    const clientBaseUrl = host ? `${proto}://${host}` : defaultFrontend;

    const resetUrl = `${clientBaseUrl.replace(/\/+$/, '')}/reset-password?token=${rawToken}&email=${encodeURIComponent(user.email)}`;

    await sendEmail({
      to: user.email,
      subject: 'EventGen — Password Reset Request',
      text: `Hello ${user.name},\n\nYou requested a password reset for your EventGen account.\nPlease click the link below or paste it into your browser:\n\n${resetUrl}\n\nThis link will expire in 1 hour.\nIf you did not request this, please ignore this email.`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eaeaea; border-radius: 8px;">
          <h2 style="color: #4F46E5;">EventGen Password Reset</h2>
          <p>Hello <strong>${user.name}</strong>,</p>
          <p>You requested a password reset for your EventGen account.</p>
          <div style="margin: 25px 0;">
            <a href="${resetUrl}" style="background-color: #4F46E5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">Reset Password</a>
          </div>
          <p style="color: #666; font-size: 13px;">This link will expire in 1 hour. If you did not request this, please ignore this email.</p>
        </div>
      `
    });

    res.json({
      success: true,
      message: 'If the email exists, a password reset link has been sent.'
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Reset Password with token
 */
async function resetPassword(req, res, next) {
  try {
    const { token, email, newPassword } = req.body;
    if (!token || !email || !newPassword) {
      return res.status(400).json({ success: false, message: 'Token, email, and new password are required' });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ success: false, message: 'Password must be at least 8 characters long' });
    }

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    const resets = await query(
      `SELECT pr.*, u.id as user_id, u.name
       FROM password_resets pr
       JOIN users u ON pr.user_id = u.id
       WHERE pr.token_hash = ? AND u.email = ? AND pr.used_at IS NULL AND pr.expires_at > NOW()
       ORDER BY pr.created_at DESC LIMIT 1`,
      [tokenHash, email.trim().toLowerCase()]
    );

    if (resets.length === 0) {
      return res.status(400).json({ success: false, message: 'Invalid, expired, or already used reset token' });
    }

    const resetRecord = resets[0];
    const passwordHash = await bcrypt.hash(newPassword, 10);

    // Update password
    await query('UPDATE users SET password_hash = ?, updated_at = NOW() WHERE id = ?', [passwordHash, resetRecord.user_id]);

    // Mark reset token used
    await query('UPDATE password_resets SET used_at = NOW() WHERE id = ?', [resetRecord.id]);

    await logAudit({
      userId: resetRecord.user_id,
      userName: resetRecord.name,
      action: 'RESET_PASSWORD',
      entity: 'USER',
      entityId: resetRecord.user_id,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent']
    });

    res.json({
      success: true,
      message: 'Password has been reset successfully. You can now log in with your new password.'
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  login,
  refreshToken,
  getMe,
  logout,
  forgotPassword,
  resetPassword
};
