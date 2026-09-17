const jwt = require('jsonwebtoken');
const dotenv = require('dotenv');
dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET || 'eventgen_fallback_secret_key_access_2026';
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'eventgen_fallback_secret_key_refresh_2026';
const ACCESS_TOKEN_EXPIRY = process.env.JWT_EXPIRES_IN || '2h';
const REFRESH_TOKEN_EXPIRY = process.env.JWT_REFRESH_EXPIRES_IN || '30d';

function generateAccessToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRY });
}

function generateRefreshToken(payload) {
  return jwt.sign(payload, JWT_REFRESH_SECRET, { expiresIn: REFRESH_TOKEN_EXPIRY });
}

function verifyAccessToken(token) {
  try {
    return { valid: true, payload: jwt.verify(token, JWT_SECRET) };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

function verifyRefreshToken(token) {
  try {
    return { valid: true, payload: jwt.verify(token, JWT_REFRESH_SECRET) };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

module.exports = {
  generateAccessToken,
  generateRefreshToken,
  verifyAccessToken,
  verifyRefreshToken
};
