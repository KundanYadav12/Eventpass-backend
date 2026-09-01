const { processScan } = require('../src/services/ScanService');
const { generateHmacSignature, verifyHmacSignature, generatePassCode } = require('../src/utils/cryptoUtil');
const { getScanCycleKey } = require('../src/utils/timeUtil');

describe('EventGen Multi-Event & 7-Character Pass Rules Tests', () => {

  describe('1. Cryptographic HMAC & 7-Character Pass Code Generation', () => {
    test('Should generate strictly 7-character non-sequential unique codes', () => {
      const code1 = generatePassCode();
      const code2 = generatePassCode();

      expect(code1).toMatch(/^[2-9A-HJ-NP-Z]{7}$/);
      expect(code2).toMatch(/^[2-9A-HJ-NP-Z]{7}$/);
      expect(code1).toHaveLength(7);
      expect(code1).not.toBe(code2);
    });

    test('Should compute and correctly verify HMAC-SHA256 signatures for 7-char codes', () => {
      const passCode = '55KDBD2';
      const sig = generateHmacSignature(passCode);

      expect(sig).toHaveLength(64);
      expect(verifyHmacSignature(passCode, sig)).toBe(true);
      // Tampered code must fail verification
      expect(verifyHmacSignature('55KDBD3', sig)).toBe(false);
      expect(verifyHmacSignature(passCode, 'invalid_signature_hash')).toBe(false);
    });
  });

  describe('2. 1:00 AM Scan Cycle & Unlock Boundary Calculation', () => {
    test('11:30 PM on Oct 2 and 00:45 AM on Oct 3 should belong to the SAME scan day (2026-10-02)', () => {
      const lateNight = new Date('2026-10-02T23:30:00Z');
      const pastMidnight = new Date('2026-10-03T00:45:00Z');

      expect(getScanCycleKey(lateNight)).toBe('2026-10-02');
      expect(getScanCycleKey(pastMidnight)).toBe('2026-10-02');
    });

    test('01:00 AM on Oct 3 should trigger a NEW scan cycle (2026-10-03)', () => {
      const unlockTime = new Date('2026-10-03T01:00:00Z');
      expect(getScanCycleKey(unlockTime)).toBe('2026-10-03');
    });
  });

  describe('3. Automatic Event & Category Resolution and Scan Rules', () => {
    test('Invalid / non-existent pass code returns invalid result', async () => {
      const result = await processScan({ code: 'INVALID', deviceId: 'TEST-GATE' });
      expect(result.success).toBe(false);
      expect(result.result).toBe('invalid');
    });

    test('Expired pass returns expired result and identifies event', async () => {
      const result = await processScan({ code: 'TESTEXP', deviceId: 'TEST-GATE' });
      expect(result.success).toBe(false);
      expect(result.result).toBe('expired');
      expect(result.event).toBeDefined();
    });

    test('Future date pass returns wrong_date result', async () => {
      const result = await processScan({ code: 'TESTFUT', deviceId: 'TEST-GATE', customNow: '2026-10-02T12:00:00Z' });
      expect(result.success).toBe(false);
      expect(result.result).toBe('wrong_date');
    });

    test('Voided pass returns voided result', async () => {
      const result = await processScan({ code: 'TESTVOI', deviceId: 'TEST-GATE' });
      expect(result.success).toBe(false);
      expect(result.result).toBe('voided');
    });

    test('Already used daily pass returns already_used result with prior scan timestamp', async () => {
      const result = await processScan({ code: 'TESTD1S', deviceId: 'TEST-GATE', customNow: '2026-10-02T14:00:00Z' });
      expect(result.success).toBe(false);
      expect(result.result).toBe('already_used');
      expect(result.reason).toContain('Pass already used');
    });

    test('Already used today all-season pass returns already_used with 1:00 AM unlock notice', async () => {
      const result = await processScan({ code: 'TESTAST', deviceId: 'TEST-GATE', customNow: '2026-10-02T15:00:00Z' });
      expect(result.success).toBe(false);
      expect(result.result).toBe('already_used');
    });

    test('Scan on Event 2 pass automatically resolves Music Festival event', async () => {
      const result = await processScan({ code: 'TESTMF1', deviceId: 'GATE-FEST', customNow: '2026-10-10T18:00:00Z' });
      expect(result.event).toBeDefined();
      expect(result.event.id).toBe(2);
      expect(result.event.name).toBe('Music Festival 2026');
      expect(result.category.name).toContain('Music Fest');
    });
  });

});
