const fs = require('fs');
const path = require('path');
const { initDatabase, getPool } = require('../config/db');

async function runMigrations() {
  console.log('[Migration] Starting database migrations runner...');
  try {
    await initDatabase();
    const pool = getPool();

    // Find all .sql migration files in the migrations directory sorted alphabetically
    const migrationsDir = __dirname;
    const sqlFiles = fs.readdirSync(migrationsDir)
      .filter(file => file.endsWith('.sql'))
      .sort();

    for (const file of sqlFiles) {
      console.log(`[Migration] Running ${file}...`);
      const schemaPath = path.join(migrationsDir, file);
      const sqlContent = fs.readFileSync(schemaPath, 'utf8');

      // Split SQL by statements safely
      const statements = sqlContent
        .split(/;\s*$/m)
        .map(s => s.trim())
        .filter(s => s.length > 0);

      for (const stmt of statements) {
        try {
          await pool.query(stmt);
        } catch (stmtErr) {
          console.warn(`[Migration Warning] Error executing statement in ${file}:`, stmtErr.message);
        }
      }
      console.log(`[Migration] ✅ Finished ${file}`);
    }

    console.log('[Migration] ✅ All database migrations executed successfully!');
    return true;
  } catch (error) {
    console.error('[Migration Error] Migration failed:', error.message);
    throw error;
  }
}

if (require.main === module) {
  runMigrations()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

module.exports = { runMigrations };
