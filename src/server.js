const app = require('./app');
const { initDatabase } = require('./config/db');
const { initRedis } = require('./config/redis');
const { runMigrations } = require('./migrations/runMigrations');

const PORT = parseInt(process.env.PORT || '5006', 10);

async function startServer() {
  try {
    console.log('====================================================');
    console.log('       EVENTGEN EVENT TICKETING BACKEND API         ');
    console.log('====================================================');
    console.log(`[Config] Target Port: ${PORT}`);
    console.log(`[Config] Environment: ${process.env.NODE_ENV || 'development'}`);
    
    // Initialize MySQL Database
    await initDatabase();

    // Auto-run schema migrations on startup
    await runMigrations();

    // Initialize Redis (with automatic fallback to atomic memory lock)
    initRedis();

    // Start Express listener
    app.listen(PORT, () => {
      console.log(`[Server] 🚀 Server running successfully on http://localhost:${PORT}`);
      console.log(`[Server] 📡 Health check: http://localhost:${PORT}/api/health`);
      console.log(`[Server] 🔒 API Endpoint: http://localhost:${PORT}/api`);
    });
  } catch (error) {
    console.error('[Server Start Error] Critical failure during startup:', error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  startServer();
}

module.exports = { startServer };
