const { getPool, withTransaction } = require('../config/db');
const { acquireLock } = require('../config/redis');
const { verifyHmacSignature } = require('../utils/cryptoUtil');
const {
  checkValidityWindow,
  calculateRenewalCycle,
  hasScannedInCurrentCycle,
  formatDateTimeIST,
  formatDateIST,
  formatTimeIST,
  formatMySqlDateTime
} = require('../utils/timeUtil');
const { getMessage } = require('./MessageService');

/**
 * Scan verification service with automatic event & category resolution, atomic locking, and robust debouncing
 * Standardized on Indian Standard Time (IST, UTC+5:30)
 * 
 * @param {Object} params
 * @param {string} params.code - 7-character barcode/QR pass code (e.g. "55KDBD2")
 * @param {string} params.deviceId - Scanner Device / Gate ID (e.g. "GATE-01")
 * @param {number} [params.operatorId] - Authenticated user ID of the gate operator
 * @param {string} [params.ipAddress] - Client IP address
 * @param {Date} [params.customNow] - Optional injected date for automated time-travel testing
 */
async function processScan({ code, deviceId = 'GATE-DEFAULT', operatorId = null, ipAddress = null, customNow = null }) {
  const scanTime = customNow ? new Date(customNow) : new Date();
  const sqlScanTime = formatMySqlDateTime(scanTime);
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
                c.id as resolved_category_id, c.name as category_name, c.code as category_code, c.max_daily_scans,
                c.scan_behavior, c.renewal_time, c.renewal_active_from, c.renewal_active_until
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
           VALUES (?, ?, ?, ?, 'invalid', 'Pass code not found in database', ?)`,
          [cleanCode, deviceId, operatorId, sqlScanTime, ipAddress]
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
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'invalid', ?, ?)`,
          [eventId, categoryId, pass.id, pass.code, pass.code_type, deviceId, operatorId, sqlScanTime, msg, ipAddress]
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
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'invalid', 'HMAC signature verification failed - Possible counterfeit', ?)`,
          [eventId, categoryId, pass.id, pass.code, pass.code_type, deviceId, operatorId, sqlScanTime, ipAddress]
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
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'voided', ?, ?)`,
          [eventId, categoryId, pass.id, pass.code, pass.code_type, deviceId, operatorId, sqlScanTime, msg, ipAddress]
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

      // 5. Date & Validity Window Check in IST
      const validityStatus = checkValidityWindow(scanTime, pass.valid_from, pass.valid_until);

      if (validityStatus === 'future') {
        const fromDateFormatted = formatDateIST(pass.valid_from);
        const defaultMsg = `This pass is valid on ${fromDateFormatted}. Please return on that date.`;
        const msg = (await getMessage('WRONG_DATE', defaultMsg)).replace('{date}', fromDateFormatted);

        await conn.query(
          `INSERT INTO scan_history (event_id, category_id, pass_id, pass_code, pass_type, device_id, operator_id, scan_time, result, reason, ip_address)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'wrong_date', ?, ?)`,
          [eventId, categoryId, pass.id, pass.code, pass.code_type, deviceId, operatorId, sqlScanTime, msg, ipAddress]
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
        const untilDateFormatted = formatDateIST(pass.valid_until);
        const defaultMsg = `This pass expired on ${untilDateFormatted}. Entry denied.`;
        const msg = (await getMessage('PASS_EXPIRED', defaultMsg)).replace('{date}', untilDateFormatted);

        if (pass.status !== 'expired') {
          await conn.query('UPDATE passes SET status = "expired", updated_at = NOW() WHERE id = ?', [pass.id]);
        }

        await conn.query(
          `INSERT INTO scan_history (event_id, category_id, pass_id, pass_code, pass_type, device_id, operator_id, scan_time, result, reason, ip_address)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'expired', ?, ?)`,
          [eventId, categoryId, pass.id, pass.code, pass.code_type, deviceId, operatorId, sqlScanTime, msg, ipAddress]
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

      // 6. Branch based on Configurable Scan Behavior (Mode A vs Mode B)
      const scanBehavior = (pass.scan_behavior || 'ONE_TIME').toUpperCase();

      // =========================================================================
      // MODE A — One-Time Use (Permanent Expiry)
      // =========================================================================
      if (scanBehavior === 'ONE_TIME') {
        if (pass.status === 'used' || (pass.scan_count && pass.scan_count >= 1) || pass.first_scanned_at) {
          const originalScanDate = pass.first_scanned_at || pass.last_scanned_at;
          const timeFormatted = originalScanDate ? formatDateTimeIST(originalScanDate) : 'earlier';
          const reason = `Pass already used at ${timeFormatted}. This pass is permanently expired and cannot be used again.`;
          const msg = 'Pass Already Used — This pass is permanently expired and cannot be used again.';

          await conn.query(
            `INSERT INTO scan_history (event_id, category_id, pass_id, pass_code, pass_type, device_id, operator_id, scan_time, result, reason, ip_address)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'already_used', ?, ?)`,
            [eventId, categoryId, pass.id, pass.code, pass.code_type, deviceId, operatorId, sqlScanTime, reason, ipAddress]
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

        // Approve One-Time Pass
        await conn.query(
          `UPDATE passes
           SET status = 'used',
               scan_count = scan_count + 1,
               first_scanned_at = COALESCE(first_scanned_at, ?),
               last_scanned_at = ?,
               updated_at = NOW()
           WHERE id = ?`,
          [sqlScanTime, sqlScanTime, pass.id]
        );

        const msg = await getMessage('ENTRY_APPROVED', 'Entry Approved');
        await conn.query(
          `INSERT INTO scan_history (event_id, category_id, pass_id, pass_code, pass_type, device_id, operator_id, scan_time, result, reason, ip_address)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?)`,
          [eventId, categoryId, pass.id, pass.code, pass.code_type, deviceId, operatorId, sqlScanTime, 'One-Time Pass Entry Approved', ipAddress]
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
            firstScannedAt: pass.first_scanned_at || scanTime.toISOString(),
            lastScannedAt: scanTime.toISOString()
          }
        };
      }

      // =========================================================================
      // MODE B — Renewable (Scheduled Daily / Recurring Reset in IST)
      // =========================================================================
      const activeFrom = pass.renewal_active_from || pass.valid_from;
      const activeUntil = pass.renewal_active_until || pass.valid_until;
      const renewalTimeStr = pass.renewal_time || '01:00';

      const cycle = calculateRenewalCycle(scanTime, renewalTimeStr, activeFrom, activeUntil);

      if (cycle.status === 'expired') {
        const msg = `This pass has expired. Renewal active window ended on ${cycle.activeUntilIST}.`;
        await conn.query(
          `INSERT INTO scan_history (event_id, category_id, pass_id, pass_code, pass_type, device_id, operator_id, scan_time, result, reason, ip_address)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'expired', ?, ?)`,
          [eventId, categoryId, pass.id, pass.code, pass.code_type, deviceId, operatorId, sqlScanTime, msg, ipAddress]
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

      if (cycle.status === 'future') {
        const msg = `Pass renewal is not yet active. Renewal window starts on ${cycle.activeFromIST}.`;
        await conn.query(
          `INSERT INTO scan_history (event_id, category_id, pass_id, pass_code, pass_type, device_id, operator_id, scan_time, result, reason, ip_address)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'wrong_date', ?, ?)`,
          [eventId, categoryId, pass.id, pass.code, pass.code_type, deviceId, operatorId, sqlScanTime, msg, ipAddress]
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

      // Check if already scanned within the active cycle
      const alreadyScannedInCurrentCycle = hasScannedInCurrentCycle(pass.last_scanned_at, cycle.cycleStart);

      if (alreadyScannedInCurrentCycle) {
        const lastScanTimeFormatted = formatDateTimeIST(pass.last_scanned_at);
        const windowSuffix = cycle.activeWindowFormatted ? `, within ${cycle.activeWindowFormatted} window` : '';
        const reason = `Already scanned today at ${lastScanTimeFormatted}. Unlocks at ${cycle.nextUnlockFormatted}${windowSuffix}.`;
        const msg = `Pass Already Used Today. Unlocks at ${cycle.nextUnlockTimeFormatted}${windowSuffix}.`;

        await conn.query(
          `INSERT INTO scan_history (event_id, category_id, pass_id, pass_code, pass_type, device_id, operator_id, scan_time, result, reason, ip_address)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'already_used', ?, ?)`,
          [eventId, categoryId, pass.id, pass.code, pass.code_type, deviceId, operatorId, sqlScanTime, reason, ipAddress]
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

      // Approve Renewable Pass for current shift/cycle
      const isFirstScan = !pass.first_scanned_at;
      await conn.query(
        `UPDATE passes
         SET scan_count = scan_count + 1,
             first_scanned_at = COALESCE(first_scanned_at, ?),
             last_scanned_at = ?,
             updated_at = NOW()
         WHERE id = ?`,
        [sqlScanTime, sqlScanTime, pass.id]
      );

      const approvedMsg = await getMessage('ENTRY_APPROVED', 'Entry Approved');
      await conn.query(
        `INSERT INTO scan_history (event_id, category_id, pass_id, pass_code, pass_type, device_id, operator_id, scan_time, result, reason, ip_address)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?)`,
        [eventId, categoryId, pass.id, pass.code, pass.code_type, deviceId, operatorId, sqlScanTime, `Renewable Pass Entry Approved (Cycle: ${formatTimeIST(renewalTimeStr)})`, ipAddress]
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
          firstScannedAt: isFirstScan ? scanTime.toISOString() : pass.first_scanned_at,
          lastScannedAt: scanTime.toISOString()
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
    code: pass.category_code || pass.code_type,
    scanBehavior: pass.scan_behavior || 'ONE_TIME',
    renewalTime: pass.renewal_time || '01:00',
    renewalActiveFrom: pass.renewal_active_from,
    renewalActiveUntil: pass.renewal_active_until
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
