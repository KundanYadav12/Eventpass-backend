const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { query } = require('./src/config/db');

async function createBackupAndDryRun() {
  const eventId = 1; // Raas Utsav 2026
  const categoryId = 1; // Daily Pass — 2 Oct (D1)
  const keepLimit = 3003;

  // 1. Fetch total count
  const [totalRow] = await query(
    'SELECT COUNT(*) as total FROM passes WHERE event_id = ? AND category_id = ?',
    [eventId, categoryId]
  );
  const total = totalRow.total;

  // 2. Fetch the IDs to KEEP (First 3,003 ordered by id ASC / created_at ASC)
  const keepRows = await query(
    `SELECT id, code, created_at FROM passes 
     WHERE event_id = ? AND category_id = ? 
     ORDER BY id ASC 
     LIMIT ?`,
    [eventId, categoryId, keepLimit]
  );

  const minKeepId = keepRows[0]?.id;
  const maxKeepId = keepRows[keepRows.length - 1]?.id;

  // 3. Fetch the records to DELETE (All records after the first 3003)
  const deleteRows = await query(
    `SELECT * FROM passes 
     WHERE event_id = ? AND category_id = ? AND id > ?
     ORDER BY id ASC`,
    [eventId, categoryId, maxKeepId]
  );

  // 4. Check child scan history records for delete rows
  const [scanHistoryCount] = await query(
    `SELECT COUNT(*) as count FROM scan_history 
     WHERE pass_id IN (
       SELECT id FROM (
         SELECT id FROM passes WHERE event_id = ? AND category_id = ? AND id > ?
       ) as tmp
     )`,
    [eventId, categoryId, maxKeepId]
  );

  console.log('================================================================');
  console.log('                 DRY-RUN DELETION SUMMARY                       ');
  console.log('================================================================');
  console.log(`Event                : Raas Utsav 2026 (ID: ${eventId})`);
  console.log(`Category             : Daily Pass — 2 Oct (D1, ID: ${categoryId})`);
  console.log(`Total Passes in DB   : ${total}`);
  console.log(`Passes to KEEP       : ${keepRows.length} (IDs: ${minKeepId} -> ${maxKeepId})`);
  console.log(`Passes to DELETE     : ${deleteRows.length} (IDs: ${deleteRows[0]?.id} -> ${deleteRows[deleteRows.length - 1]?.id})`);
  console.log(`Linked Scan Records  : ${scanHistoryCount.count}`);
  console.log(`Expected Remaining   : ${total - deleteRows.length}`);
  console.log('================================================================\n');

  // 5. Save JSON backup
  const backupDir = path.join(__dirname, 'backups');
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonBackupFile = path.join(backupDir, `passes_backup_event1_cat1_${timestamp}.json`);
  fs.writeFileSync(jsonBackupFile, JSON.stringify(deleteRows, null, 2), 'utf8');
  console.log(`✅ Exported ${deleteRows.length} records to JSON backup:`);
  console.log(`   ${jsonBackupFile} (${(fs.statSync(jsonBackupFile).size / 1024 / 1024).toFixed(2)} MB)\n`);

  // 6. Generate SQL INSERT statements for restoration
  const sqlBackupFile = path.join(backupDir, `passes_backup_event1_cat1_${timestamp}.sql`);
  let sqlContent = `-- Backup of ${deleteRows.length} passes deleted from EventGen (Event 1, Category 1)\n`;
  sqlContent += `-- Created at: ${new Date().toISOString()}\n\n`;

  const chunkSize = 100;
  for (let i = 0; i < deleteRows.length; i += chunkSize) {
    const chunk = deleteRows.slice(i, i + chunkSize);
    const valueStrings = chunk.map(p => {
      const vFrom = p.valid_from ? `'${new Date(p.valid_from).toISOString().slice(0, 19).replace('T', ' ')}'` : 'NULL';
      const vUntil = p.valid_until ? `'${new Date(p.valid_until).toISOString().slice(0, 19).replace('T', ' ')}'` : 'NULL';
      const cAt = p.created_at ? `'${new Date(p.created_at).toISOString().slice(0, 19).replace('T', ' ')}'` : 'NULL';
      const uAt = p.updated_at ? `'${new Date(p.updated_at).toISOString().slice(0, 19).replace('T', ' ')}'` : 'NULL';
      const fScanned = p.first_scanned_at ? `'${new Date(p.first_scanned_at).toISOString().slice(0, 19).replace('T', ' ')}'` : 'NULL';
      const lScanned = p.last_scanned_at ? `'${new Date(p.last_scanned_at).toISOString().slice(0, 19).replace('T', ' ')}'` : 'NULL';
      
      return `(${p.id}, ${p.event_id}, ${p.category_id}, '${p.code}', '${p.hmac_sig}', '${p.code_type}', '${p.status}', ${p.printed}, ${p.print_batch_id || 'NULL'}, ${p.scan_count || 0}, ${fScanned}, ${lScanned}, ${vFrom}, ${vUntil}, ${p.created_by || 'NULL'}, ${cAt}, ${uAt})`;
    });

    sqlContent += `INSERT IGNORE INTO passes (id, event_id, category_id, code, hmac_sig, code_type, status, printed, print_batch_id, scan_count, first_scanned_at, last_scanned_at, valid_from, valid_until, created_by, created_at, updated_at) VALUES\n${valueStrings.join(',\n')};\n\n`;
  }

  fs.writeFileSync(sqlBackupFile, sqlContent, 'utf8');
  console.log(`✅ Generated SQL restoration script:`);
  console.log(`   ${sqlBackupFile} (${(fs.statSync(sqlBackupFile).size / 1024 / 1024).toFixed(2)} MB)\n`);
}

createBackupAndDryRun().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
