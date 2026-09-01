const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { query } = require('./src/config/db');

async function checkPasses() {
  const cat1Stats = await query(`
    SELECT COUNT(*) as total,
           MIN(id) as min_id,
           MAX(id) as max_id,
           SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active_count,
           SUM(CASE WHEN status = 'used' THEN 1 ELSE 0 END) as used_count
    FROM passes
    WHERE event_id = 1 AND category_id = 1
  `);
  console.log('Daily Pass — 2 Oct (D1) Current Count in DB:', cat1Stats[0]);

  // Check top 3003
  const keep = await query(`
    SELECT id, code, status, created_at
    FROM passes
    WHERE event_id = 1 AND category_id = 1
    ORDER BY id ASC
    LIMIT 3003
  `);
  console.log('Top 3003 count:', keep.length);
  if (keep.length > 0) {
    console.log('First pass (#1):', keep[0]);
    console.log('Cutoff pass (#3003):', keep[keep.length - 1]);
  }

  // Check any excess
  const excess = await query(`
    SELECT COUNT(*) as excess_count
    FROM passes
    WHERE event_id = 1 AND category_id = 1 AND id > ?
  `, [keep[keep.length - 1]?.id || 18034]);
  console.log('Excess passes to delete:', excess[0].excess_count);
}

checkPasses().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
