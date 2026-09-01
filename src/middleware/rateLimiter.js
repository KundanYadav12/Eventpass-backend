const rateLimit = require('express-rate-limit');

// Rate limiter for general API endpoints
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 300, // 300 requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many requests from this IP, please try again later.'
  }
});

// Rate limiter for Auth / Login attempts
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 25, // 25 attempts per 15 minutes
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many login attempts. Please try again after 15 minutes.'
  }
});

// High-throughput limiter for Gate Scanner endpoints
const scanLimiter = rateLimit({
  windowMs: 1000, // 1 second
  max: 30, // 30 scans per second per device/IP
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    result: 'rate_limited',
    message: 'Too many scan requests. Please wait a moment.'
  }
});

module.exports = {
  apiLimiter,
  authLimiter,
  scanLimiter
};
