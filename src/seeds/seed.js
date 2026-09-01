const bcrypt = require('bcryptjs');
const { initDatabase, getPool } = require('../config/db');
const { generatePassCode, generateHmacSignature } = require('../utils/cryptoUtil');
const { runMigrations } = require('../migrations/runMigrations');

async function seed() {
  console.log('====================================================');
  console.log('    EVENTGEN MULTI-EVENT DATABASE SEED SCRIPT       ');
  console.log('====================================================');

  await initDatabase();
  await runMigrations();
  const pool = getPool();

  console.log('[Seed] 1. Seeding Roles & Permissions...');

  await pool.query(`INSERT IGNORE INTO roles (id, name, description) VALUES
    (1, 'SUPERADMIN', 'Full global system access across all events'),
    (2, 'ADMIN', 'Event-scoped operational access, scanning, pass lookup, print management')`);

  const permissionsList = [
    { code: 'events.manage', name: 'Manage Events', module: 'Events', desc: 'Create and configure events' },
    { code: 'dashboard.view', name: 'View Dashboard', module: 'Dashboard', desc: 'Access analytics and KPI metrics' },
    { code: 'passes.view', name: 'View Passes', module: 'Passes', desc: 'View paginated passes table and search' },
    { code: 'passes.generate', name: 'Generate Passes', module: 'Passes', desc: 'Generate new passes for categories' },
    { code: 'passes.renew', name: 'Renew Passes', module: 'Passes', desc: 'Renew individual or bulk passes' },
    { code: 'passes.void', name: 'Void Passes', module: 'Passes', desc: 'Void or cancel passes' },
    { code: 'passes.reissue', name: 'Reissue Passes', module: 'Passes', desc: 'Reissue new pass code' },
    { code: 'scan.operate', name: 'Perform Scans', module: 'Scanner', desc: 'Scan passes at gates' },
    { code: 'scan.history', name: 'View Scan History', module: 'Scanner', desc: 'View gate scan logs' },
    { code: 'print.manage', name: 'Manage Print Batches', module: 'Print', desc: 'Create, start, pause batches' },
    { code: 'users.manage', name: 'Manage Users', module: 'Users', desc: 'Create and edit admin accounts' },
    { code: 'messages.edit', name: 'Edit Messages', module: 'Messages', desc: 'Edit scanner messages' },
    { code: 'audit.view', name: 'View Audit Logs', module: 'Audit', desc: 'View administrative audit trail' }
  ];

  for (const p of permissionsList) {
    await pool.query(
      `INSERT INTO permissions (code, name, module, description) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name), module = VALUES(module), description = VALUES(description)`,
      [p.code, p.name, p.module, p.desc]
    );
  }

  // Grant all permissions to SuperAdmin (Role 1)
  const allPerms = await pool.query('SELECT id FROM permissions');
  for (const p of allPerms[0]) {
    await pool.query(`INSERT IGNORE INTO role_permissions (role_id, permission_id) VALUES (1, ?)`, [p.id]);
  }

  // Grant operational permissions to Admin (Role 2)
  const adminPermCodes = ['dashboard.view', 'passes.view', 'passes.generate', 'passes.renew', 'scan.operate', 'scan.history', 'print.manage'];
  for (const p of allPerms[0]) {
    const [permRecord] = await pool.query('SELECT code FROM permissions WHERE id = ?', [p.id]);
    if (permRecord.length > 0 && adminPermCodes.includes(permRecord[0].code)) {
      await pool.query(`INSERT IGNORE INTO role_permissions (role_id, permission_id) VALUES (2, ?)`, [p.id]);
    }
  }

  console.log('[Seed] 2. Seeding Multi-Event Entities...');

  const events = [
    {
      id: 1,
      name: 'Corporate Expo 2026',
      code: 'EXPO2026',
      desc: 'Annual Technology & Enterprise Innovation Exhibition',
      venue: 'Grand Convention Center, Hall A & B',
      start: '2026-10-02 00:00:00',
      end: '2026-10-04 23:59:59',
      status: 'active'
    },
    {
      id: 2,
      name: 'Music Festival 2026',
      code: 'MUSIC2026',
      desc: '3-Day Live Outdoor Music and Arts Festival',
      venue: 'Riverside Amphitheater Park',
      start: '2026-10-10 00:00:00',
      end: '2026-10-12 23:59:59',
      status: 'active'
    }
  ];

  for (const ev of events) {
    await pool.query(
      `INSERT INTO events (id, event_name, event_code, description, venue, event_start_date, event_end_date, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE event_name = VALUES(event_name), event_code = VALUES(event_code), venue = VALUES(venue), event_start_date = VALUES(event_start_date), event_end_date = VALUES(event_end_date), status = VALUES(status)`,
      [ev.id, ev.name, ev.code, ev.desc, ev.venue, ev.start, ev.end, ev.status]
    );
  }

  console.log('[Seed] 3. Seeding Accounts for SuperAdmin and Event-Specific Admins...');

  const superAdminPassword = process.env.SUPERADMIN_PASSWORD || 'SuperAdmin@2026!';
  const adminPassword = process.env.ADMIN_PASSWORD || 'Admin@2026!';

  const superAdminHash = await bcrypt.hash(superAdminPassword, 10);
  const adminHash = await bcrypt.hash(adminPassword, 10);

  // Global SuperAdmin (event_id: NULL)
  await pool.query(
    `INSERT INTO users (id, name, email, password_hash, role_id, event_id, is_active, created_at)
     VALUES (1, 'Super Administrator', 'superadmin@eventgen.com', ?, 1, NULL, 1, NOW())
     ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), event_id = NULL`,
    [superAdminHash]
  );

  // Event 1 Admin
  await pool.query(
    `INSERT INTO users (id, name, email, password_hash, role_id, event_id, is_active, created_at)
     VALUES (2, 'Expo Gate Admin', 'admin@eventgen.com', ?, 2, 1, 1, NOW())
     ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), event_id = 1`,
    [adminHash]
  );

  // Event 2 Admin
  await pool.query(
    `INSERT INTO users (id, name, email, password_hash, role_id, event_id, is_active, created_at)
     VALUES (3, 'Music Festival Admin', 'admin.music@eventgen.com', ?, 2, 2, 1, NOW())
     ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), event_id = 2`,
    [adminHash]
  );

  console.log('----------------------------------------------------');
  console.log('MULTI-EVENT CREDENTIALS:');
  console.log(' SuperAdmin (All Events):   superadmin@eventgen.com / ' + superAdminPassword);
  console.log(' Expo Admin (Event 1):      admin@eventgen.com / ' + adminPassword);
  console.log(' Music Admin (Event 2):     admin.music@eventgen.com / ' + adminPassword);
  console.log('----------------------------------------------------');

  console.log('[Seed] 4. Seeding Pass Categories...');

  const categories = [
    // Event 1 Categories
    {
      id: 1,
      eventId: 1,
      code: 'daily_oct2',
      prefix: 'D1',
      name: 'Daily Pass — 2 Oct',
      description: 'Single-use pass valid strictly on 2 October 2026.',
      valid_from: '2026-10-02 00:00:00',
      valid_until: '2026-10-02 23:59:59',
      total_quantity: 3000,
      max_daily_scans: 1,
      price: 49.00
    },
    {
      id: 2,
      eventId: 1,
      code: 'daily_oct3',
      prefix: 'D2',
      name: 'Daily Pass — 3 Oct',
      description: 'Single-use pass valid strictly on 3 October 2026.',
      valid_from: '2026-10-03 00:00:00',
      valid_until: '2026-10-03 23:59:59',
      total_quantity: 3000,
      max_daily_scans: 1,
      price: 49.00
    },
    {
      id: 3,
      eventId: 1,
      code: 'daily_oct4',
      prefix: 'D3',
      name: 'Daily Pass — 4 Oct',
      description: 'Single-use pass valid strictly on 4 October 2026.',
      valid_from: '2026-10-04 00:00:00',
      valid_until: '2026-10-04 23:59:59',
      total_quantity: 3000,
      max_daily_scans: 1,
      price: 49.00
    },
    {
      id: 4,
      eventId: 1,
      code: 'all_season',
      prefix: 'AS',
      name: 'All-Season Pass',
      description: 'Multi-day pass valid from 2 Oct through 4 Oct 2026. Max 1 entry per calendar day (1:00 AM reset).',
      valid_from: '2026-10-02 00:00:00',
      valid_until: '2026-10-04 23:59:59',
      total_quantity: 4000,
      max_daily_scans: 1,
      price: 129.00
    },
    // Event 2 Categories
    {
      id: 5,
      eventId: 2,
      code: 'music_day1',
      prefix: 'M1',
      name: 'Music Fest — Day 1',
      description: 'Friday Night Live Acts pass.',
      valid_from: '2026-10-10 00:00:00',
      valid_until: '2026-10-10 23:59:59',
      total_quantity: 1500,
      max_daily_scans: 1,
      price: 65.00
    },
    {
      id: 6,
      eventId: 2,
      code: 'music_vip',
      prefix: 'VIP',
      name: 'VIP Backstage Weekend Pass',
      description: 'Full 3-day VIP access with hospitality lounge.',
      valid_from: '2026-10-10 00:00:00',
      valid_until: '2026-10-12 23:59:59',
      total_quantity: 500,
      max_daily_scans: 1,
      price: 250.00
    }
  ];

  for (const cat of categories) {
    await pool.query(
      `INSERT INTO pass_categories (id, event_id, code, category_prefix, name, description, valid_from, valid_until, total_quantity, max_daily_scans, price, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE event_id = VALUES(event_id), code = VALUES(code), category_prefix = VALUES(category_prefix), name = VALUES(name), description = VALUES(description), valid_from = VALUES(valid_from), valid_until = VALUES(valid_until), total_quantity = VALUES(total_quantity)`,
      [cat.id, cat.eventId, cat.code, cat.prefix, cat.name, cat.description, cat.valid_from, cat.valid_until, cat.total_quantity, cat.max_daily_scans, cat.price]
    );
  }

  console.log('[Seed] 5. Seeding Scanner Messages Config...');

  const defaultMessages = [
    { key: 'ENTRY_APPROVED', text: 'Entry Approved', desc: 'Shown when a pass is valid and successfully verified' },
    { key: 'PASS_ALREADY_USED', text: 'Pass Already Used', desc: 'Shown when a single-use daily pass is scanned again' },
    { key: 'PASS_ALREADY_USED_TODAY', text: 'Pass Already Used Today. Unlocks tomorrow at 1:00 AM.', desc: 'Shown when an all-season pass is scanned more than once on the same calendar day' },
    { key: 'PASS_EXPIRED', text: 'This pass has expired. Entry denied.', desc: 'Shown when a pass is scanned after its valid_until date/time' },
    { key: 'WRONG_DATE', text: 'This pass is not valid for today. Please return on valid date.', desc: 'Shown when a pass is scanned prior to its valid_from date/time' },
    { key: 'PASS_VOIDED', text: 'This pass is voided and invalid. Entry denied.', desc: 'Shown when a voided pass is presented at the gate' },
    { key: 'INVALID_CODE', text: 'Invalid pass code or untrusted barcode.', desc: 'Shown when the barcode does not exist or HMAC fails' },
    { key: 'SYSTEM_ERROR', text: 'System error during pass verification.', desc: 'Fallback error message' }
  ];

  for (const m of defaultMessages) {
    await pool.query(
      `INSERT INTO messages_config (event_id, message_key, message_text, description, updated_at)
       VALUES (NULL, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE message_text = VALUES(message_text), description = VALUES(description)`,
      [m.key, m.text, m.desc]
    );
  }

  console.log('[Seed] 6. Checking and Generating 7-Character Pass Inventory...');

  // Generate passes for Event 1 (13,000 total) and Event 2 (2,000 total)
  for (const cat of categories) {
    const [currentCatPasses] = await pool.query('SELECT COUNT(*) as count FROM passes WHERE category_id = ? OR (code_type = ? AND event_id = ?)', [cat.id, cat.code, cat.eventId]);
    const needed = cat.total_quantity - currentCatPasses[0].count;

    if (needed > 0) {
      console.log(` -> Generating ${needed} 7-character passes for '${cat.name}' (Event ${cat.eventId})...`);
      const BATCH_SIZE = 500;
      let generated = 0;

      while (generated < needed) {
        const thisChunkSize = Math.min(BATCH_SIZE, needed - generated);
        const values = [];

        for (let i = 0; i < thisChunkSize; i++) {
          const code = generatePassCode(); // Strictly 7-character unambiguous string (e.g. 55KDBD2)
          const hmac = generateHmacSignature(code);
          values.push([cat.eventId, cat.id, code, cat.code, cat.prefix, hmac, 'active', cat.valid_from, cat.valid_until, false]);
        }

        const placeholders = values.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(',');
        const flatParams = values.flat();

        const [insertResult] = await pool.query(
          `INSERT IGNORE INTO passes (event_id, category_id, code, code_type, category_prefix, hmac_sig, status, valid_from, valid_until, printed)
           VALUES ${placeholders}`,
          flatParams
        );

        generated += insertResult.affectedRows;
      }
      console.log(`    ✅ Finished '${cat.name}' (${cat.total_quantity} passes).`);
    }
  }

  console.log('[Seed] 7. Seeding Dedicated 7-Character QA Test Passes for Verification...');

  const testPasses = [
    // 7-character test codes
    { code: 'TESTD1U', eventId: 1, catId: 1, type: 'daily_oct2', from: '2026-10-02 00:00:00', until: '2026-10-02 23:59:59', status: 'active', scanCount: 0 },
    { code: 'TESTD1S', eventId: 1, catId: 1, type: 'daily_oct2', from: '2026-10-02 00:00:00', until: '2026-10-02 23:59:59', status: 'used', scanCount: 1, firstScan: '2026-10-02 10:15:00', lastScan: '2026-10-02 10:15:00' },
    { code: 'TESTEXP', eventId: 1, catId: 1, type: 'daily_oct2', from: '2026-08-01 00:00:00', until: '2026-08-15 23:59:59', status: 'expired', scanCount: 0 },
    { code: 'TESTFUT', eventId: 1, catId: 3, type: 'daily_oct4', from: '2026-12-01 00:00:00', until: '2026-12-01 23:59:59', status: 'active', scanCount: 0 },
    { code: 'TESTASU', eventId: 1, catId: 4, type: 'all_season', from: '2026-10-02 00:00:00', until: '2026-10-04 23:59:59', status: 'active', scanCount: 0 },
    { code: 'TESTAST', eventId: 1, catId: 4, type: 'all_season', from: '2026-10-02 00:00:00', until: '2026-10-04 23:59:59', status: 'active', scanCount: 1, firstScan: '2026-10-02 09:30:00', lastScan: '2026-10-02 09:30:00' },
    { code: 'TESTVOI', eventId: 1, catId: 2, type: 'daily_oct3', from: '2026-10-03 00:00:00', until: '2026-10-03 23:59:59', status: 'void', scanCount: 0 },
    // Live valid pass for today's instant scan testing
    { code: 'TESTNOW', eventId: 1, catId: 4, type: 'all_season', from: '2026-01-01 00:00:00', until: '2026-12-31 23:59:59', status: 'active', scanCount: 0 },
    // Event 2 QA pass
    { code: 'TESTMF1', eventId: 2, catId: 5, type: 'music_day1', from: '2026-10-10 00:00:00', until: '2026-10-10 23:59:59', status: 'active', scanCount: 0 }
  ];

  for (const tp of testPasses) {
    const hmac = generateHmacSignature(tp.code);
    await pool.query(
      `INSERT INTO passes (code, event_id, category_id, code_type, hmac_sig, status, valid_from, valid_until, scan_count, first_scanned_at, last_scanned_at, printed, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NOW())
       ON DUPLICATE KEY UPDATE event_id = VALUES(event_id), category_id = VALUES(category_id), status = VALUES(status), valid_from = VALUES(valid_from), valid_until = VALUES(valid_until), scan_count = VALUES(scan_count), first_scanned_at = VALUES(first_scanned_at), last_scanned_at = VALUES(last_scanned_at)`,
      [tp.code, tp.eventId, tp.catId, tp.type, hmac, tp.status, tp.from, tp.until, tp.scanCount, tp.firstScan || null, tp.lastScan || null]
    );
  }

  console.log('====================================================');
  console.log('   ✅ MULTI-EVENT DATABASE SEEDING COMPLETED!       ');
  console.log('====================================================');
}

if (require.main === module) {
  seed()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[Seed Error]:', err);
      process.exit(1);
    });
}

module.exports = { seed };
