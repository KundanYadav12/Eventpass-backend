const { processScan } = require('../src/services/ScanService');
const { query } = require('../src/config/db');
const { generateHmacSignature } = require('../src/utils/cryptoUtil');

describe('Concurrency & Race Condition Scan Protection', () => {
  const CONCURRENT_PASS_CODE = 'TEST-CONCURRENCY-01';

  beforeAll(async () => {
    const hmac = generateHmacSignature(CONCURRENT_PASS_CODE);
    await query(
      `INSERT INTO passes (code, code_type, hmac_sig, status, valid_from, valid_until, scan_count, printed, created_at)
       VALUES (?, 'daily_oct2', ?, 'active', '2026-10-02 00:00:00', '2026-10-02 23:59:59', 0, 1, NOW())
       ON DUPLICATE KEY UPDATE status = 'active', scan_count = 0, first_scanned_at = NULL, last_scanned_at = NULL`,
      [CONCURRENT_PASS_CODE, hmac]
    );
  });

  test('10 simultaneous parallel scan attempts on the same pass must result in EXACTLY 1 approved scan', async () => {
    const parallelScans = Array.from({ length: 10 }, (_, index) =>
      processScan({
        code: CONCURRENT_PASS_CODE,
        deviceId: `GATE-${index + 1}`,
        customNow: '2026-10-02T12:00:00Z'
      })
    );

    const results = await Promise.all(parallelScans);

    const approvedResults = results.filter(r => r.result === 'approved');
    const deniedResults = results.filter(r => r.result === 'already_used');

    console.log(`[Concurrency Test] Out of 10 parallel scans: ${approvedResults.length} approved, ${deniedResults.length} denied.`);

    expect(approvedResults.length).toBe(1);
    expect(deniedResults.length).toBe(9);
  });
});
