const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { query, withTransaction } = require('./src/config/db');

async function executeTrim() {
  const eventId = 1;
  const categoryId = 1;
  const cutoffPassId = 18034; // Max ID of the first 3003 passes

  console.log('Executing safe trim inside MySQL transaction...');

  const result = await withTransaction(async (conn) => {
    // 1. Verify counts before deletion
    const [beforeTotal] = await conn.query(
      'SELECT COUNT(*) as count FROM passes WHERE event_id = ? AND category_id = ?',
      [eventId, categoryId]
    );

    const [toDeleteCount] = await conn.query(
      'SELECT COUNT(*) as count FROM passes WHERE event_id = ? AND category_id = ? AND id > ?',
      [eventId, categoryId, cutoffPassId]
    );

    console.log(`Pre-check: Total in Cat 1: ${beforeTotal[0].count}, Excess to remove: ${toDeleteCount[0].count}`);

    // 2. Delete linked scan history for passes to be removed (if any)
    const [scanDeleteRes] = await conn.query(
      `DELETE FROM scan_history 
       WHERE pass_id IN (
         SELECT id FROM (
           SELECT id FROM passes 
           WHERE event_id = ? AND category_id = ? AND id > ?
         ) as tmp
       )`,
      [eventId, categoryId, cutoffPassId]
    );
    console.log(`Cleaned up ${scanDeleteRes.affectedRows} linked scan history rows.`);

    // 3. Delete the excess passes
    const [passDeleteRes] = await conn.query(
      'DELETE FROM passes WHERE event_id = ? AND category_id = ? AND id > ?',
      [eventId, categoryId, cutoffPassId]
    );
    console.log(`Deleted ${passDeleteRes.affectedRows} excess passes.`);

    // 4. Verify post-deletion total is exactly 3003
    const [afterTotal] = await conn.query(
      'SELECT COUNT(*) as count FROM passes WHERE event_id = ? AND category_id = ?',
      [eventId, categoryId]
    );

    if (afterTotal[0].count !== 3003) {
      throw new Error(`Integrity check failed: Expected exactly 3003 passes, found ${afterTotal[0].count}. Rolling back transaction!`);
    }

    // 5. Update pass_categories total_quantity to 3003 if needed
    await conn.query(
      'UPDATE pass_categories SET total_quantity = 3003, updated_at = NOW() WHERE id = ?',
      [categoryId]
    );

    return {
      deletedCount: passDeleteRes.affectedRows,
      remainingCount: afterTotal[0].count
    };
  });

  console.log('✅ Transaction committed successfully!');
  console.log('Result:', result);
  return result;
}

if (require.main === module) {
  executeTrim().then(() => process.exit(0)).catch(err => {
    console.error('❌ Execution failed:', err);
    process.exit(1);
  });
}

module.exports = { executeTrim };
