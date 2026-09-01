const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { query } = require('./src/config/db');

async function verifyAllCounts() {
  console.log('=== VERIFYING FINAL PASS COUNTS ACROSS ALL CATEGORIES & EVENTS ===');

  const categories = await query(`
    SELECT c.id, c.event_id, c.name, c.code, c.category_prefix, e.event_name,
           (SELECT COUNT(*) FROM passes p WHERE p.category_id = c.id) as pass_count,
           (SELECT COUNT(*) FROM passes p WHERE p.category_id = c.id AND p.status = 'active') as active_count,
           (SELECT COUNT(*) FROM passes p WHERE p.category_id = c.id AND p.status = 'used') as used_count
    FROM pass_categories c
    JOIN events e ON c.event_id = e.id
    ORDER BY c.event_id ASC, c.id ASC
  `);

  console.table(categories);

  const [totalPasses] = await query('SELECT COUNT(*) as total FROM passes');
  console.log('Total passes across all events in database:', totalPasses.total);

  // Check min & max ID for Raas Utsav Category 1
  const [d1Bounds] = await query(`
    SELECT MIN(id) as first_pass_id, MAX(id) as last_pass_id, COUNT(*) as count
    FROM passes
    WHERE event_id = 1 AND category_id = 1
  `);
  console.log('Daily Pass — 2 Oct (D1) Bounds:', d1Bounds);
}

verifyAllCounts().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
