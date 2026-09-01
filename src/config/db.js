const mysql = require('mysql2/promise');
const dotenv = require('dotenv');
dotenv.config();

const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '3306', 10),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'eventgen_db',
  waitForConnections: true,
  connectionLimit: 20,
  queueLimit: 0,
  timezone: '+00:00',
  dateStrings: true
};

let pool = null;

async function initDatabase() {
  try {
    // First connect without database to ensure eventgen_db exists
    const adminConnection = await mysql.createConnection({
      host: dbConfig.host,
      port: dbConfig.port,
      user: dbConfig.user,
      password: dbConfig.password
    });

    await adminConnection.query(
      `CREATE DATABASE IF NOT EXISTS \`${dbConfig.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
    await adminConnection.end();

    // Now create connection pool to the database
    pool = mysql.createPool(dbConfig);
    console.log(`[Database] MySQL pool connected to database '${dbConfig.database}' at ${dbConfig.host}:${dbConfig.port}`);
    return pool;
  } catch (err) {
    console.error(`[Database Error] Failed to initialize database '${dbConfig.database}':`, err.message);
    // Attempt connecting directly with root if user failed, or create pool anyway
    try {
      pool = mysql.createPool(dbConfig);
      return pool;
    } catch (poolErr) {
      console.error('[Database Error] Direct pool connection failed:', poolErr.message);
      throw poolErr;
    }
  }
}

function getPool() {
  if (!pool) {
    pool = mysql.createPool(dbConfig);
  }
  return pool;
}

async function query(sql, params = []) {
  const p = getPool();
  const [rows] = await p.query(sql, params);
  return rows;
}

async function execute(sql, params = []) {
  const p = getPool();
  const [result] = await p.execute(sql, params);
  return result;
}

async function withTransaction(callback) {
  const p = getPool();
  const connection = await p.getConnection();
  try {
    await connection.beginTransaction();
    const result = await callback(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

module.exports = {
  initDatabase,
  getPool,
  query,
  execute,
  withTransaction,
  dbConfig
};
