const crypto = require('crypto');

const SECRET_KEY = crypto
  .createHash('sha256')
  .update(process.env.ENCRYPTION_KEY || process.env.JWT_SECRET || 'eventgen_vault_master_key_2026_aes_gcm_salt')
  .digest();

const ALGORITHM = 'aes-256-gcm';

// 32-character unambiguous charset (excluding 0, O, 1, I, L)
const UNAMBIGUOUS_CHARSET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/**
 * Generate a strictly 7-character unambiguous alphanumeric pass code
 */
function generatePassCode() {
  let code = '';
  const bytes = crypto.randomBytes(7);
  for (let i = 0; i < 7; i++) {
    code += UNAMBIGUOUS_CHARSET[bytes[i] % UNAMBIGUOUS_CHARSET.length];
  }
  return code;
}

/**
 * Generate HMAC SHA256 signature for security verification
 */
function generateHmacSignature(code) {
  const secret = process.env.HMAC_SECRET || 'eventpass_super_secret_hmac_key_2026';
  return crypto.createHmac('sha256', secret).update(String(code).toUpperCase()).digest('hex');
}

/**
 * Verify HMAC signature
 */
function verifyHmacSignature(code, signature) {
  if (!code || !signature) return false;
  const expected = generateHmacSignature(code);
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
}

/**
 * Encrypt a plain text secret using AES-256-GCM
 */
function encryptSecret(plainText) {
  if (!plainText || typeof plainText !== 'string') return null;

  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, SECRET_KEY, iv);

  let encrypted = cipher.update(plainText, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag().toString('hex');

  return {
    encrypted,
    iv: iv.toString('hex'),
    authTag
  };
}

/**
 * Decrypt an AES-256-GCM encrypted secret
 */
function decryptSecret(encryptedHex, ivHex, authTagHex) {
  if (!encryptedHex || !ivHex || !authTagHex) return null;

  try {
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, SECRET_KEY, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    console.error('[Crypto Error] Failed to decrypt credential:', err.message);
    return null;
  }
}

/**
 * Returns a masked version of a secret for secure API serialization
 */
function maskSecret(hasValue) {
  return hasValue ? '••••••••' : '';
}

/**
 * Generate a cryptographically secure, random, non-sequential token (e.g. 16 hex characters)
 */
function generateSecureToken(length = 16) {
  return crypto.randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length);
}

module.exports = {
  generatePassCode,
  generateHmacSignature,
  verifyHmacSignature,
  generateSecureToken,
  encryptSecret,
  decryptSecret,
  maskSecret
};

