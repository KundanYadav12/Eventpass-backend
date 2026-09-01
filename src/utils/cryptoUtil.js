const crypto = require('crypto');
const dotenv = require('dotenv');
dotenv.config();

const HMAC_SECRET = process.env.HMAC_SECRET || 'eventgen_pass_hmac_sha256_cryptographic_secret_9981';

// Unambiguous 32-character alphanumeric set (excluding confusing characters: 0, O, 1, I, L)
const CHARSET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/**
 * Generate a cryptographically secure, non-sequential, unambiguous 7-character pass code
 * @param {number} length - Length of pass code (strictly 7 characters)
 * @returns {string} e.g. "55KDBD2", "T7A3ATC", "M77DA1V"
 */
function generateSecureRandomCode(length = 7) {
  const bytes = crypto.randomBytes(length * 2);
  let result = '';
  let i = 0;
  while (result.length < length && i < bytes.length) {
    const byte = bytes[i];
    if (byte < 256 - (256 % CHARSET.length)) {
      result += CHARSET[byte % CHARSET.length];
    }
    i++;
  }
  // Fallback if needed
  while (result.length < length) {
    const extra = crypto.randomBytes(1)[0];
    result += CHARSET[extra % CHARSET.length];
  }
  return result;
}

/**
 * Generate pass code strictly as 7 characters (no hardcoded prefixes)
 * @returns {string} 7-character string e.g. "55KDBD2"
 */
function generatePassCode() {
  return generateSecureRandomCode(7);
}

/**
 * Generate HMAC-SHA256 signature for a pass code
 * @param {string} code 
 * @returns {string} 64-character hex signature
 */
function generateHmacSignature(code) {
  return crypto
    .createHmac('sha256', HMAC_SECRET)
    .update(String(code).trim().toUpperCase())
    .digest('hex');
}

/**
 * Verify HMAC signature with constant-time comparison to prevent timing attacks
 * @param {string} code 
 * @param {string} expectedSig 
 * @returns {boolean}
 */
function verifyHmacSignature(code, expectedSig) {
  if (!code || !expectedSig) return false;
  const actualSig = generateHmacSignature(code);
  
  if (actualSig.length !== expectedSig.length) return false;

  const actualBuffer = Buffer.from(actualSig, 'hex');
  const expectedBuffer = Buffer.from(expectedSig, 'hex');

  try {
    return crypto.timingSafeEqual(actualBuffer, expectedBuffer);
  } catch (e) {
    return false;
  }
}

module.exports = {
  generateSecureRandomCode,
  generatePassCode,
  generateHmacSignature,
  verifyHmacSignature
};
