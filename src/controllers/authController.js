const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { query } = require('../config/db');
const { generateAccessToken, generateRefreshToken, verifyRefreshToken } = require('../config/jwt');
const { sendEmail } = require('../config/email');
const { logAudit } = require('../services/AuditService');

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
      `SELECT u.*, r.name as role_name
       FROM users u
       JOIN roles r ON u.role_id = r.id
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
    const permissions = await query(
      `SELECT p.code FROM permissions p
       JOIN role_permissions rp ON p.id = rp.permission_id
       WHERE rp.role_id = ?`,
      [user.role_id]
    );

    // Update last login
    await query('UPDATE users SET last_login_at = NOW() WHERE id = ?', [user.id]);

    const tokenPayload = {
      userId: user.id,
      email: user.email,
      role: user.role_name
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
        permissions: permissions.map(p => p.code)
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

    const users = await query('SELECT id, email, role_id, is_active FROM users WHERE id = ?', [payload.userId]);
    if (users.length === 0 || !users[0].is_active) {
      return res.status(403).json({ success: false, message: 'User inactive or not found' });
    }

    const newAccessToken = generateAccessToken({
      userId: payload.userId,
      email: payload.email,
      role: payload.role
    });

    res.json({
      success: true,
      accessToken: newAccessToken
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

    const resetUrl = `${process.env.FRONTEND_URL || 'https://eventgen.duckdns.org'}/reset-password?token=${rawToken}&email=${encodeURIComponent(user.email)}`;

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
