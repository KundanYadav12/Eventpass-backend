const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { query } = require('./src/config/db');

async function summary() {
  const categories = await query(`
    SELECT c.id as category_id, c.event_id, e.event_name, c.name as category_name, c.category_prefix,
           COUNT(p.id) as current_pass_count,
           c.total_quantity as quota_configured
    FROM pass_categories c
    JOIN events e ON e.id = c.event_id
    LEFT JOIN passes p ON p.category_id = c.id
    GROUP BY c.id
    ORDER BY c.event_id, c.id
  `);
  console.log('=== PASS INVENTORY BREAKDOWN ===');
  console.table(categories);
}

summary().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
