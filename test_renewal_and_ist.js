require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { query } = require('./src/config/db');
const { processScan } = require('./src/services/ScanService');
const { generateHmacSignature } = require('./src/utils/cryptoUtil');
const {
  formatDateTimeIST,
  formatDateIST,
  formatTimeIST,
  calculateRenewalCycle,
  hasScannedInCurrentCycle
} = require('./src/utils/timeUtil');

async function runTests() {
  console.log('====================================================');
  console.log('   TESTING CONFIGURABLE RENEWAL RULES & IST TIME    ');
  console.log('====================================================\n');

  try {
    // 1. Test IST Date & Time Formatter
    console.log('[Test 1] Validating Indian Standard Time (IST) Date Utility...');
    const testUtcDate = new Date('2026-10-02T12:30:00Z'); // 12:30 UTC = 18:00 (6:00 PM) IST
    const formattedIST = formatDateTimeIST(testUtcDate);
    const dateOnlyIST = formatDateIST(testUtcDate);
    const timeOnlyIST = formatTimeIST('06:00');

    console.log(`- 12:30:00 UTC in IST : ${formattedIST}`);
    console.log(`- Date in IST         : ${dateOnlyIST}`);
    console.log(`- Time "06:00" in 12h : ${timeOnlyIST}`);

    if (!formattedIST.includes('06:00 PM') || dateOnlyIST !== '2 Oct 2026' || timeOnlyIST !== '06:00 AM') {
      throw new Error(`IST formatting mismatch: got ${formattedIST}`);
    }
    console.log('✅ IST Date Formatter passed!\n');

    // 2. Setup Test Event & Test Categories in MySQL
    console.log('[Test 2] Setting up Mode A & Mode B test categories in DB...');
    
    // Ensure test event exists
    await query(`
      INSERT INTO events (id, event_name, event_code, event_start_date, event_end_date, status)
      VALUES (999, 'Test Fest 2026', 'TF26', '2026-10-01 00:00:00', '2026-10-10 23:59:59', 'active')
      ON DUPLICATE KEY UPDATE status = 'active', event_name = 'Test Fest 2026'
    `);

    // Create Mode A Category (One-Time Use)
    await query(`
      INSERT INTO pass_categories (id, event_id, code, category_prefix, name, valid_from, valid_until, scan_behavior, renewal_time)
      VALUES (991, 999, 'test_mode_a', 'TMA', 'Test Mode A One-Time', '2026-10-01 00:00:00', '2026-10-10 23:59:59', 'ONE_TIME', '01:00')
      ON DUPLICATE KEY UPDATE scan_behavior = 'ONE_TIME'
    `);

    // Create Mode B Category (Renewable @ 06:00 AM IST)
    await query(`
      INSERT INTO pass_categories (id, event_id, code, category_prefix, name, valid_from, valid_until, scan_behavior, renewal_time, renewal_active_from, renewal_active_until)
      VALUES (992, 999, 'test_mode_b', 'TMB', 'Test Mode B Renewable', '2026-10-01 00:00:00', '2026-10-10 23:59:59', 'RENEWABLE', '06:00', '2026-10-01 00:00:00', '2026-10-05 23:59:59')
      ON DUPLICATE KEY UPDATE scan_behavior = 'RENEWABLE', renewal_time = '06:00', renewal_active_from = '2026-10-01 00:00:00', renewal_active_until = '2026-10-05 23:59:59'
    `);

    // Clean up previous test passes
    await query('DELETE FROM passes WHERE code IN ("TEST1A1", "TEST2B2")');

    // Insert Mode A pass
    const hmacA = generateHmacSignature('TEST1A1');
    await query(`
      INSERT INTO passes (code, event_id, category_id, code_type, hmac_sig, status, scan_count, valid_from, valid_until)
      VALUES ('TEST1A1', 999, 991, 'test_mode_a', ?, 'active', 0, '2026-10-01 00:00:00', '2026-10-10 23:59:59')
    `, [hmacA]);

    // Insert Mode B pass
    const hmacB = generateHmacSignature('TEST2B2');
    await query(`
      INSERT INTO passes (code, event_id, category_id, code_type, hmac_sig, status, scan_count, valid_from, valid_until)
      VALUES ('TEST2B2', 999, 992, 'test_mode_b', ?, 'active', 0, '2026-10-01 00:00:00', '2026-10-10 23:59:59')
    `, [hmacB]);

    console.log('✅ Test passes created.\n');

    // 3. Test Mode A (One-Time Use): Scan 1 (Approve) & Scan 2 (Permanent Expiry)
    console.log('[Test 3] Executing Mode A (One-Time Use) verification...');
    const scanTime1 = new Date('2026-10-02T04:00:00Z'); // 09:30 AM IST
    
    // Scan 1
    const resA1 = await processScan({ code: 'TEST1A1', deviceId: 'GATE-01', customNow: scanTime1 });
    console.log('- Scan 1 Result:', resA1.result, '| Message:', resA1.message);
    if (!resA1.success || resA1.result !== 'approved') {
      throw new Error(`Mode A scan 1 expected 'approved', got ${resA1.result}`);
    }

    // Scan 2 (Should be permanently rejected)
    const scanTime2 = new Date('2026-10-03T04:00:00Z'); // Next day
    const resA2 = await processScan({ code: 'TEST1A1', deviceId: 'GATE-01', customNow: scanTime2 });
    console.log('- Scan 2 Result:', resA2.result, '| Message:', resA2.message, '| Reason:', resA2.reason);
    
    if (resA2.success || resA2.result !== 'already_used') {
      throw new Error(`Mode A scan 2 expected 'already_used', got ${resA2.result}`);
    }
    if (resA2.message.includes('tomorrow') || resA2.message.includes('unlocks')) {
      throw new Error(`Mode A message must not mention 'tomorrow' or 'unlocks': ${resA2.message}`);
    }
    if (!resA2.message.includes('permanently expired')) {
      throw new Error(`Mode A message expected 'permanently expired', got: ${resA2.message}`);
    }
    console.log('✅ Mode A (One-Time Use) permanent expiry test passed!\n');

    // 4. Test Mode B (Renewable): Scan 1, Duplicate Scan on same shift, Next Cycle Scan
    console.log('[Test 4] Executing Mode B (Renewable @ 06:00 AM IST) verification...');
    // Shift 1: 2 Oct 2026, 08:00 AM IST (02:30 UTC) - after 06:00 AM IST reset
    const scanTimeB1 = new Date('2026-10-02T02:30:00Z');
    
    const resB1 = await processScan({ code: 'TEST2B2', deviceId: 'GATE-01', customNow: scanTimeB1 });
    console.log('- Shift 1 Scan Result:', resB1.result, '| Message:', resB1.message);
    if (!resB1.success || resB1.result !== 'approved') {
      throw new Error(`Mode B scan 1 expected 'approved', got ${resB1.result}`);
    }

    // Duplicate Scan on same shift: 2 Oct 2026, 02:00 PM IST (08:30 UTC)
    const scanTimeB2 = new Date('2026-10-02T08:30:00Z');
    const resB2 = await processScan({ code: 'TEST2B2', deviceId: 'GATE-01', customNow: scanTimeB2 });
    console.log('- Shift 1 Duplicate Result:', resB2.result, '| Message:', resB2.message);
    
    if (resB2.success || resB2.result !== 'already_used') {
      throw new Error(`Mode B duplicate scan expected 'already_used', got ${resB2.result}`);
    }
    if (!resB2.message.includes('06:00 AM') || !resB2.message.includes('window')) {
      throw new Error(`Mode B duplicate message expected dynamic unlock time 06:00 AM and window: ${resB2.message}`);
    }

    // Next Shift Scan: 3 Oct 2026, 07:00 AM IST (01:30 UTC) - after 06:00 AM IST next reset
    const scanTimeB3 = new Date('2026-10-03T01:30:00Z');
    const resB3 = await processScan({ code: 'TEST2B2', deviceId: 'GATE-01', customNow: scanTimeB3 });
    console.log('- Next Shift Scan Result:', resB3.result, '| Message:', resB3.message, '| Scan Count:', resB3.pass?.scanCount);
    if (!resB3.success || resB3.result !== 'approved' || resB3.pass?.scanCount !== 2) {
      throw new Error(`Mode B next shift scan expected 'approved' with scanCount 2, got ${JSON.stringify(resB3)}`);
    }

    // Scan outside renewal active window: 6 Oct 2026 (Renewal active until 5 Oct)
    const scanTimeB4 = new Date('2026-10-06T04:00:00Z');
    const resB4 = await processScan({ code: 'TEST2B2', deviceId: 'GATE-01', customNow: scanTimeB4 });
    console.log('- Outside Active Window Result:', resB4.result, '| Message:', resB4.message);
    if (resB4.success || resB4.result !== 'expired') {
      throw new Error(`Mode B outside active window expected 'expired', got ${resB4.result}`);
    }
    console.log('✅ Mode B (Renewable) dynamic cycle and active window tests passed!\n');

    // Clean up test data
    await query('DELETE FROM passes WHERE code IN ("TEST1A1", "TEST2B2")');
    await query('DELETE FROM pass_categories WHERE id IN (991, 992)');
    await query('DELETE FROM events WHERE id = 999');

    console.log('====================================================');
    console.log('         ALL VERIFICATION TESTS PASSED!             ');
    console.log('====================================================');
    process.exit(0);
  } catch (err) {
    console.error('\n❌ Test Failure:', err.message);
    process.exit(1);
  }
}

runTests();
