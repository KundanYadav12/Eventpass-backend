const { getPool, withTransaction } = require('../config/db');
const { acquireLock } = require('../config/redis');
const { verifyHmacSignature } = require('../utils/cryptoUtil');
const { getScanCycleKey, checkValidityWindow } = require('../utils/timeUtil');
const { getMessage } = require('./MessageService');

/**
 * Scan verification service with automatic event & category resolution, atomic locking, and robust debouncing
 * @param {Object} params
 * @param {string} params.code - 7-character barcode/QR pass code (e.g. "55KDBD2")
 * @param {string} params.deviceId - Scanner Device / Gate ID (e.g. "GATE-01")
 * @param {number} [params.operatorId] - Authenticated user ID of the gate operator
 * @param {string} [params.ipAddress] - Client IP address
 * @param {Date} [params.customNow] - Optional injected date for automated time-travel testing
 */
async function processScan({ code, deviceId = 'GATE-DEFAULT', operatorId = null, ipAddress = null, customNow = null }) {
  const scanTime = customNow ? new Date(customNow) : new Date();
  const cleanCode = (code || '').trim().toUpperCase();

  if (!cleanCode) {
    return {
      success: false,
      result: 'invalid',
      message: await getMessage('INVALID_CODE', 'Invalid pass code')
    };
  }

  // 1. Acquire distributed lock for atomic single-execution
  const lockKey = `lock:scan:${cleanCode}`;
  const lock = await acquireLock(lockKey, 5000);
  
  if (!lock.acquired) {
    return {
      success: false,
      result: 'already_used',
      message: 'Pass is currently being processed at another gate. Please try again.'
    };
  }

  try {
    let scanResult = null;

    // 2. Perform validation inside MySQL transaction with Row-Level Locking (SELECT ... FOR UPDATE)
    scanResult = await withTransaction(async (conn) => {
      // Query pass record with event and category joins
      const [passes] = await conn.query(
        `SELECT p.*,
                e.id as resolved_event_id, e.event_name, e.event_code, e.status as event_status,
                c.id as resolved_category_id, c.name as category_name, c.code as category_code, c.max_daily_scans
         FROM passes p
         LEFT JOIN events e ON p.event_id = e.id
         LEFT JOIN pass_categories c ON (p.category_id = c.id OR (p.code_type = c.code AND p.event_id = c.event_id))
         WHERE p.code = ?
         FOR UPDATE`,
        [cleanCode]
      );

      if (passes.length === 0) {
        // Record invalid scan attempt
        await conn.query(
          `INSERT INTO scan_history (pass_code, device_id, operator_id, scan_time, result, reason, ip_address)
           VALUES (?, ?, ?, NOW(), 'invalid', 'Pass code not found in database', ?)`,
          [cleanCode, deviceId, operatorId, ipAddress]
        );

        return {
          success: false,
          result: 'invalid',
          message: await getMessage('INVALID_CODE', 'Invalid pass code')
        };
      }

      const pass = passes[0];
      const eventId = pass.resolved_event_id || pass.event_id;
      const categoryId = pass.resolved_category_id || pass.category_id;

      // Event Status check
      if (pass.event_status === 'inactive' || pass.event_status === 'completed') {
        const msg = `Event '${pass.event_name}' is not currently active.`;
        await conn.query(
          `INSERT INTO scan_history (event_id, category_id, pass_id, pass_code, pass_type, device_id, operator_id, scan_time, result, reason, ip_address)
           VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), 'invalid', ?, ?)`,
          [eventId, categoryId, pass.id, pass.code, pass.code_type, deviceId, operatorId, msg, ipAddress]
        );

        return {
          success: false,
          result: 'invalid',
          message: msg,
          event: formatEventPayload(pass),
          category: formatCategoryPayload(pass),
          pass: formatPassPayload(pass)
        };
      }

      // 3. Cryptographic HMAC Verification
      const isHmacValid = verifyHmacSignature(pass.code, pass.hmac_sig);
      if (!isHmacValid) {
        await conn.query(
          `INSERT INTO scan_history (event_id, category_id, pass_id, pass_code, pass_type, device_id, operator_id, scan_time, result, reason, ip_address)
           VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), 'invalid', 'HMAC signature verification failed - Possible counterfeit', ?)`,
          [eventId, categoryId, pass.id, pass.code, pass.code_type, deviceId, operatorId, ipAddress]
        );

        return {
          success: false,
          result: 'invalid',
          message: await getMessage('INVALID_CODE', 'Pass signature is invalid or tampered with')
        };
      }

      // 4. Check if pass is Voided
      if (pass.status === 'void') {
        const msg = await getMessage('PASS_VOIDED', 'This pass is voided and invalid. Entry denied.');
        await conn.query(
          `INSERT INTO scan_history (event_id, category_id, pass_id, pass_code, pass_type, device_id, operator_id, scan_time, result, reason, ip_address)
           VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), 'voided', ?, ?)`,
          [eventId, categoryId, pass.id, pass.code, pass.code_type, deviceId, operatorId, msg, ipAddress]
        );

        return {
          success: false,
          result: 'voided',
          message: msg,
          event: formatEventPayload(pass),
          category: formatCategoryPayload(pass),
          pass: formatPassPayload(pass)
        };
      }

      // 5. Date & Validity Window Check
      const validityStatus = checkValidityWindow(scanTime, pass.valid_from, pass.valid_until);

      if (validityStatus === 'future') {
        const fromDateFormatted = new Date(pass.valid_from).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
        const defaultMsg = `This pass is valid on ${fromDateFormatted}. Please return on that date.`;
        const msg = (await getMessage('WRONG_DATE', defaultMsg)).replace('{date}', fromDateFormatted);

        await conn.query(
          `INSERT INTO scan_history (event_id, category_id, pass_id, pass_code, pass_type, device_id, operator_id, scan_time, result, reason, ip_address)
           VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), 'wrong_date', ?, ?)`,
          [eventId, categoryId, pass.id, pass.code, pass.code_type, deviceId, operatorId, msg, ipAddress]
        );

        return {
          success: false,
          result: 'wrong_date',
          message: msg,
          event: formatEventPayload(pass),
          category: formatCategoryPayload(pass),
          pass: formatPassPayload(pass)
        };
      }

      if (validityStatus === 'expired' || pass.status === 'expired') {
        const untilDateFormatted = new Date(pass.valid_until).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
        const defaultMsg = `This pass expired on ${untilDateFormatted}. Entry denied.`;
        const msg = (await getMessage('PASS_EXPIRED', defaultMsg)).replace('{date}', untilDateFormatted);

        if (pass.status !== 'expired') {
          await conn.query('UPDATE passes SET status = "expired", updated_at = NOW() WHERE id = ?', [pass.id]);
        }

        await conn.query(
          `INSERT INTO scan_history (event_id, category_id, pass_id, pass_code, pass_type, device_id, operator_id, scan_time, result, reason, ip_address)
           VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), 'expired', ?, ?)`,
          [eventId, categoryId, pass.id, pass.code, pass.code_type, deviceId, operatorId, msg, ipAddress]
        );

        return {
          success: false,
          result: 'expired',
          message: msg,
          event: formatEventPayload(pass),
          category: formatCategoryPayload(pass),
          pass: formatPassPayload(pass)
        };
      }

      // 6. Category Rules (Daily Single-Use vs Multi-Day Season)
      const isDailyPass = pass.code_type?.startsWith('daily') || pass.max_daily_scans === 1 && pass.valid_from === pass.valid_until;

      if (isDailyPass && pass.code_type !== 'all_season') {
        if (pass.status === 'used' || pass.scan_count > 0) {
          const originalScanDate = pass.first_scanned_at || pass.last_scanned_at;
          const timeFormatted = originalScanDate
            ? new Date(originalScanDate).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
            : 'earlier';
          const reason = `Pass already used at ${timeFormatted}`;
          const msg = await getMessage('PASS_ALREADY_USED', 'Pass Already Used');

          await conn.query(
            `INSERT INTO scan_history (event_id, category_id, pass_id, pass_code, pass_type, device_id, operator_id, scan_time, result, reason, ip_address)
             VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), 'already_used', ?, ?)`,
            [eventId, categoryId, pass.id, pass.code, pass.code_type, deviceId, operatorId, reason, ipAddress]
          );

          return {
            success: false,
            result: 'already_used',
            message: msg,
            reason: reason,
            firstScannedAt: pass.first_scanned_at,
            lastScannedAt: pass.last_scanned_at,
            event: formatEventPayload(pass),
            category: formatCategoryPayload(pass),
            pass: formatPassPayload(pass)
          };
        }

        // Approve Daily Pass
        await conn.query(
          `UPDATE passes
           SET status = 'used',
               scan_count = scan_count + 1,
               first_scanned_at = COALESCE(first_scanned_at, NOW()),
               last_scanned_at = NOW(),
               updated_at = NOW()
           WHERE id = ?`,
          [pass.id]
        );

        const msg = await getMessage('ENTRY_APPROVED', 'Entry Approved');
        await conn.query(
          `INSERT INTO scan_history (event_id, category_id, pass_id, pass_code, pass_type, device_id, operator_id, scan_time, result, reason, ip_address)
           VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), 'approved', ?, ?)`,
          [eventId, categoryId, pass.id, pass.code, pass.code_type, deviceId, operatorId, 'Daily Pass Entry Approved', ipAddress]
        );

        return {
          success: true,
          result: 'approved',
          message: msg,
          event: formatEventPayload(pass),
          category: formatCategoryPayload(pass),
          pass: {
            ...formatPassPayload(pass),
            status: 'used',
            scanCount: (pass.scan_count || 0) + 1,
            firstScannedAt: pass.first_scanned_at || new Date().toISOString(),
            lastScannedAt: new Date().toISOString()
          }
        };
      }

      // Multi-Day / All-Season Pass (Max 1 scan per calendar day, 1:00 AM server reset)
      const currentCycleKey = getScanCycleKey(scanTime);
      let alreadyScannedInCurrentCycle = false;

      if (pass.last_scanned_at && pass.scan_count > 0) {
        const lastCycleKey = getScanCycleKey(pass.last_scanned_at);
        if (currentCycleKey === lastCycleKey) {
          alreadyScannedInCurrentCycle = true;
        }
      }

      if (alreadyScannedInCurrentCycle) {
        const lastScanTimeFormatted = new Date(pass.last_scanned_at).toLocaleString('en-GB', {
          day: 'numeric',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit'
        });
        const reason = `Already scanned today at ${lastScanTimeFormatted}. Unlocks tomorrow at 1:00 AM.`;
        const msg = await getMessage('PASS_ALREADY_USED_TODAY', 'Pass Already Used Today');

        await conn.query(
          `INSERT INTO scan_history (event_id, category_id, pass_id, pass_code, pass_type, device_id, operator_id, scan_time, result, reason, ip_address)
           VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), 'already_used', ?, ?)`,
          [eventId, categoryId, pass.id, pass.code, pass.code_type, deviceId, operatorId, reason, ipAddress]
        );

        return {
          success: false,
          result: 'already_used',
          message: msg,
          reason,
          firstScannedAt: pass.first_scanned_at,
          lastScannedAt: pass.last_scanned_at,
          event: formatEventPayload(pass),
          category: formatCategoryPayload(pass),
          pass: formatPassPayload(pass)
        };
      }

      // Approve Multi-Day Pass for today's shift
      const isFirstScan = !pass.first_scanned_at;
      await conn.query(
        `UPDATE passes
         SET scan_count = scan_count + 1,
             first_scanned_at = COALESCE(first_scanned_at, NOW()),
             last_scanned_at = NOW(),
             updated_at = NOW()
         WHERE id = ?`,
        [pass.id]
      );

      const approvedMsg = await getMessage('ENTRY_APPROVED', 'Entry Approved');
      await conn.query(
        `INSERT INTO scan_history (event_id, category_id, pass_id, pass_code, pass_type, device_id, operator_id, scan_time, result, reason, ip_address)
         VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), 'approved', ?, ?)`,
        [eventId, categoryId, pass.id, pass.code, pass.code_type, deviceId, operatorId, 'Multi-Day Pass Entry Approved', ipAddress]
      );

      return {
        success: true,
        result: 'approved',
        message: approvedMsg,
        event: formatEventPayload(pass),
        category: formatCategoryPayload(pass),
        pass: {
          ...formatPassPayload(pass),
          scanCount: (pass.scan_count || 0) + 1,
          firstScannedAt: isFirstScan ? new Date().toISOString() : pass.first_scanned_at,
          lastScannedAt: new Date().toISOString()
        }
      };
    });

    return scanResult;
  } finally {
    await lock.release();
  }
}

function formatEventPayload(pass) {
  return {
    id: pass.resolved_event_id || pass.event_id,
    name: pass.event_name || 'Event 2026',
    code: pass.event_code || 'EVENT'
  };
}

function formatCategoryPayload(pass) {
  return {
    id: pass.resolved_category_id || pass.category_id,
    name: pass.category_name || pass.code_type,
    code: pass.category_code || pass.code_type
  };
}

function formatPassPayload(pass) {
  return {
    id: pass.id,
    code: pass.code,
    type: pass.code_type,
    categoryName: pass.category_name || pass.code_type,
    status: pass.status,
    validFrom: pass.valid_from,
    validUntil: pass.valid_until,
    printed: Boolean(pass.printed),
    firstScannedAt: pass.first_scanned_at,
    lastScannedAt: pass.last_scanned_at,
    scanCount: pass.scan_count || 0
  };
}

module.exports = {
  processScan
};
