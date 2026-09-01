const app = require('./app');
const { initDatabase, pool } = require('./config/db');
const { initRedis } = require('./config/redis');
const { runMigrations } = require('./migrations/runMigrations');

const PORT = parseInt(process.env.PORT || '5006', 10);

let serverInstance = null;

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
    serverInstance = app.listen(PORT, '0.0.0.0', () => {
      console.log(`[Server] 🚀 Server running successfully on port ${PORT}`);
      console.log(`[Server] 📡 Health check: http://localhost:${PORT}/api/health`);
      console.log(`[Server] 🔒 API Endpoint: http://localhost:${PORT}/api`);
    });

    // Graceful Shutdown Handlers
    const handleShutdown = async (signal) => {
      console.log(`\n[Server] Received ${signal}. Starting graceful shutdown...`);
      if (serverInstance) {
        serverInstance.close(async () => {
          console.log('[Server] Closed HTTP incoming connections.');
          try {
            if (pool) {
              await pool.end();
              console.log('[Database] MySQL connection pool closed cleanly.');
            }
          } catch (e) {
            console.error('[Database Shutdown Error]', e.message);
          }
          console.log('[Server] Graceful shutdown complete. Exiting.');
          process.exit(0);
        });

        // Force shutdown after 10s timeout
        setTimeout(() => {
          console.error('[Server] Forced shutdown after timeout.');
          process.exit(1);
        }, 10000);
      } else {
        process.exit(0);
      }
    };

    process.on('SIGTERM', () => handleShutdown('SIGTERM'));
    process.on('SIGINT', () => handleShutdown('SIGINT'));

  } catch (error) {
    console.error('[Server Start Error] Critical failure during startup:', error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  startServer();
}

module.exports = { startServer };
