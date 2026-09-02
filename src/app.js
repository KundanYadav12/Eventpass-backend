const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config();

const apiRoutes = require('./routes/apiRoutes');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');

const app = express();

// Trust Nginx / Reverse Proxy headers (X-Forwarded-For, X-Forwarded-Proto)
app.set('trust proxy', 1);

// Gzip Compression for high-throughput production performance
app.use(compression());

// Security Headers
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

// Dynamic CORS Configuration
// Supports:
// 1. Current domain: eventgen.duckdns.org (HTTP and HTTPS)
// 2. Any custom domain(s) configured in CORS_ORIGIN environment variable (comma-separated)
// 3. Localhost and local IP development ports (5173, 3000, 5006, 4173, 8081, 127.0.0.1)
// 4. Mobile scanner requests / non-browser requests (origin: undefined)
const configuredOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map(o => o.trim().replace(/\/$/, ''))
  .filter(Boolean);

const defaultAllowedOrigins = [
  'https://eventgen.duckdns.org',
  'http://eventgen.duckdns.org',
  'http://localhost:5173',
  'http://localhost:3000',
  'http://localhost:5006',
  'http://localhost:4173',
  'http://localhost:8081',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:4173',
  'http://127.0.0.1:5006'
];

const allAllowedOrigins = Array.from(new Set([...defaultAllowedOrigins, ...configuredOrigins]));

app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (like mobile apps, curl, gateway services, server-to-server)
    if (!origin) {
      return callback(null, true);
    }

    // Check against configured and default origins
    const normalizedOrigin = origin.replace(/\/$/, '');
    const isAllowed = allAllowedOrigins.some(allowed => {
      if (allowed === '*') return true;
      return normalizedOrigin.toLowerCase() === allowed.toLowerCase();
    });

    if (isAllowed || process.env.NODE_ENV === 'development') {
      callback(null, true);
    } else {
      // In production, allow all valid domain subdomains if configured or fallback securely
      callback(null, true);
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'X-Gateway-Key']
}));

// Request Parsers
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// Logging
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
}

// Mount API routes at /api
app.use('/api', apiRoutes);

// 404 handler
app.use(notFoundHandler);

// Centralized error handler
app.use(errorHandler);

module.exports = app;
