const { processScan } = require('../src/services/ScanService');
const { query } = require('../src/config/db');
const { generateHmacSignature, generatePassCode } = require('../src/utils/cryptoUtil');

// Extend test timeout for 1,000+ DB transactions
jest.setTimeout(120000);

describe('EventGen High-Volume Stress & Scanner Performance Tests (1,000+ Scans)', () => {
  const BATCH_SIZE = 1000;
  const stressPasses = [];

  beforeAll(async () => {
    console.log(`[Stress Test] Generating ${BATCH_SIZE} test passes...`);
    const values = [];

    for (let i = 0; i < BATCH_SIZE; i++) {
      const code = generatePassCode();
      const hmac = generateHmacSignature(code);
      stressPasses.push(code);
      values.push([1, 1, code, 'daily_oct2', 'D1', hmac, 'active', '2026-10-02 00:00:00', '2026-10-02 23:59:59', 0, 1]);
    }

    // Bulk insert in chunks of 250
    for (let i = 0; i < values.length; i += 250) {
      const chunk = values.slice(i, i + 250);
      const placeholders = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(',');
      await query(
        `INSERT IGNORE INTO passes (event_id, category_id, code, code_type, category_prefix, hmac_sig, status, valid_from, valid_until, scan_count, printed)
         VALUES ${placeholders}`,
        chunk.flat()
      );
    }
    console.log(`[Stress Test] ✅ Inserted ${BATCH_SIZE} test passes.`);
  }, 60000);

  test('1. High-Volume Batch: 1,000 Consecutive & Concurrent Scans across 10 Gates', async () => {
    const startTime = Date.now();

    // Split 1,000 passes across chunks of 20 concurrent gates
    const CHUNK_SIZE = 20;
    let totalApproved = 0;
    let totalErrors = 0;

    for (let i = 0; i < BATCH_SIZE; i += CHUNK_SIZE) {
      const batchSlice = stressPasses.slice(i, i + CHUNK_SIZE);
      const promises = batchSlice.map((passCode, idx) =>
        processScan({
          code: passCode,
          deviceId: `GATE-${(idx % 10) + 1}`,
          customNow: '2026-10-02T14:30:00Z'
        })
      );

      const batchResults = await Promise.all(promises);
      for (const res of batchResults) {
        if (res.result === 'approved') totalApproved++;
        else totalErrors++;
      }
    }

    const elapsedMs = Date.now() - startTime;
    const avgLatency = (elapsedMs / BATCH_SIZE).toFixed(2);

    console.log(`[Stress Test Result] ✅ Processed 1,000 scans in ${elapsedMs}ms (Avg: ${avgLatency}ms/scan). Approved: ${totalApproved}, Errors: ${totalErrors}`);

    expect(totalApproved).toBe(BATCH_SIZE);
    expect(totalErrors).toBe(0);
  }, 60000);

  test('2. Re-Scanning All 1,000 Passes Must Be 100% Rejected as already_used with ZERO Duplicates', async () => {
    let alreadyUsedCount = 0;
    const CHUNK_SIZE = 20;

    for (let i = 0; i < BATCH_SIZE; i += CHUNK_SIZE) {
      const batchSlice = stressPasses.slice(i, i + CHUNK_SIZE);
      const promises = batchSlice.map((passCode, idx) =>
        processScan({
          code: passCode,
          deviceId: `GATE-${(idx % 10) + 1}`,
          customNow: '2026-10-02T15:00:00Z'
        })
      );

      const batchResults = await Promise.all(promises);
      for (const res of batchResults) {
        if (res.result === 'already_used') alreadyUsedCount++;
      }
    }

    console.log(`[Re-scan Test Result] ✅ Re-scanned 1,000 used passes. Exactly ${alreadyUsedCount} rejected as already_used.`);
    expect(alreadyUsedCount).toBe(BATCH_SIZE);
  }, 60000);

  test('3. Extreme 20-Thread Parallel Collision on the EXACT SAME Pass', async () => {
    const singlePassCode = generatePassCode();
    const hmac = generateHmacSignature(singlePassCode);
    await query(
      `INSERT INTO passes (event_id, category_id, code, code_type, category_prefix, hmac_sig, status, valid_from, valid_until, scan_count, printed)
       VALUES (1, 1, ?, 'daily_oct2', 'D1', ?, 'active', '2026-10-02 00:00:00', '2026-10-02 23:59:59', 0, 1)`,
      [singlePassCode, hmac]
    );

    // 20 simultaneous parallel requests hit the backend at the exact same millisecond
    const parallelRequests = Array.from({ length: 20 }, (_, i) =>
      processScan({
        code: singlePassCode,
        deviceId: `GATE-${(i % 5) + 1}`,
        customNow: '2026-10-02T16:00:00Z'
      })
    );

    const collisionResults = await Promise.all(parallelRequests);
    const approvedCount = collisionResults.filter(r => r.result === 'approved').length;
    const alreadyUsedCount = collisionResults.filter(r => r.result === 'already_used').length;

    console.log(`[Collision Test] 20 simultaneous scans: ${approvedCount} approved, ${alreadyUsedCount} denied.`);
    expect(approvedCount).toBe(1);
    expect(alreadyUsedCount).toBe(19);
  }, 30000);

  test('4. Admin Event Isolation: Admin 1 locked to Event 1, Admin 2 locked to Event 2', async () => {
    const admin1 = await query('SELECT * FROM users WHERE email = ?', ['admin@eventgen.com']);
    const admin2 = await query('SELECT * FROM users WHERE email = ?', ['admin.music@eventgen.com']);
    const superAdmin = await query('SELECT * FROM users WHERE email = ?', ['superadmin@eventgen.com']);

    expect(admin1[0].event_id).toBe(1);
    expect(admin2[0].event_id).toBe(2);
    expect(superAdmin[0].event_id).toBeNull(); // Global superadmin
  });
});
