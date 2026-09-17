const { getPool, withTransaction, query } = require('../config/db');
const { acquireLock } = require('../config/redis');
const { verifyHmacSignature } = require('../utils/cryptoUtil');
const {
  checkValidityWindow,
  calculateRenewalCycle,
  hasScannedInCurrentCycle,
  formatDateTimeIST,
  formatDateIST,
  formatTimeIST,
  formatMySqlDateTime,
  toIsoUtcString
} = require('../utils/timeUtil');
const { getMessage } = require('./MessageService');

/**
 * Record Fraud Detection with anti-spam deduplication (5-second window)
 */
async function recordFraudDetection(conn, {
  eventId = null,
  passId = null,
  passCode,
  actualPassEventId = null,
  scannerUserId = null,
  scannerUserName = null,
  detectionType,
  reason,
  deviceId = 'GATE-01',
  ipAddress = null,
  detectedAt
}) {
  try {
    // Anti-spam check: check if identical fraud record logged in the last 5 seconds
    const [recent] = await conn.query(
      `SELECT id, detected_at FROM fraud_detections
       WHERE scanned_pass_code = ? AND detection_type = ?
       ORDER BY id DESC
       LIMIT 1`,
      [passCode, detectionType]
    );

    if (recent && recent.length > 0) {
      const prevTime = new Date(recent[0].detected_at).getTime();
      const currTime = detectedAt ? new Date(detectedAt).getTime() : Date.now();
      if (Math.abs(currTime - prevTime) <= 5000) {
        return recent[0].id;
      }
    }

    const [result] = await conn.query(
      `INSERT INTO fraud_detections
       (event_id, pass_id, scanned_pass_code, actual_pass_event_id, scanner_user_id, scanner_user_name, detection_type, reason, device_id, ip_address, detected_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        eventId,
        passId,
        passCode,
        actualPassEventId,
        scannerUserId,
        scannerUserName,
        detectionType,
        reason,
        deviceId,
        ipAddress,
        detectedAt
      ]
    );

    return result.insertId;
  } catch (err) {
    console.warn('[Fraud Detection] Warning: Failed to insert fraud record:', err.message);
    return null;
  }
}

/**
 * Scan verification service with automatic event & category resolution, atomic locking, and robust debouncing
 * Standardized on Indian Standard Time (IST, UTC+5:30)
 * 
 * @param {Object} params
 * @param {string} params.code - 7-character barcode/QR pass code (e.g. "55KDBD2")
 * @param {string} params.deviceId - Scanner Device / Gate ID (e.g. "GATE-01")
 * @param {number} [params.operatorId] - Authenticated user ID of the gate operator
 * @param {string} [params.operatorName] - Name of operator
 * @param {string} [params.operatorRole] - 'SUPERADMIN' or 'ADMIN'
 * @param {number} [params.operatorEventId] - User assigned primary event ID
 * @param {number} [params.targetEventId] - Currently selected event context
 * @param {string} [params.ipAddress] - Client IP address
 * @param {Date} [params.customNow] - Optional injected date for automated time-travel testing
 */
async function processScan({
  code,
  deviceId = 'GATE-DEFAULT',
  operatorId = null,
  operatorName = null,
  operatorRole = null,
  operatorEventId = null,
  targetEventId = null,
  checkpointId = null,
  ipAddress = null,
  customNow = null
}) {
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
      let [passes] = await conn.query(
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

      const activeEventId = targetEventId ? Number(targetEventId) : (operatorEventId ? Number(operatorEventId) : null);

      // Intelligent prefix/suffix fallback if exact match not found (e.g. scanning suffix 55KDBD2 matching D1-55KDBD2)
      if (passes.length === 0) {
        const [fallbackPasses] = await conn.query(
          `SELECT p.*,
                  e.id as resolved_event_id, e.event_name, e.event_code, e.status as event_status,
                  c.id as resolved_category_id, c.name as category_name, c.code as category_code, c.max_daily_scans,
                  c.scan_behavior, c.renewal_time, c.renewal_active_from, c.renewal_active_until
           FROM passes p
           LEFT JOIN events e ON p.event_id = e.id
           LEFT JOIN pass_categories c ON (p.category_id = c.id OR (p.code_type = c.code AND p.event_id = c.event_id))
           WHERE (p.code LIKE ? OR p.code LIKE ?)
           ${activeEventId ? 'AND p.event_id = ?' : ''}
           ORDER BY p.id ASC
           LIMIT 1
           FOR UPDATE`,
          activeEventId ? [`%-${cleanCode}`, `${cleanCode}-%`, activeEventId] : [`%-${cleanCode}`, `${cleanCode}-%`]
        );
        if (fallbackPasses.length > 0) {
          passes = fallbackPasses;
        }
      }

      // =========================================================================
      // FRAUD CASE 1: Pass Code Not Found in Database
      // =========================================================================
      if (passes.length === 0) {
        // Record invalid scan attempt in scan_history
        await conn.query(
          `INSERT INTO scan_history (pass_code, device_id, operator_id, scan_time, result, reason, ip_address)
           VALUES (?, ?, ?, ?, 'invalid', 'Pass code not found in database', ?)`,
          [cleanCode, deviceId, operatorId, sqlScanTime, ipAddress]
        );

        // Record confirmed Fraud Detection: PASS_NOT_FOUND
        await recordFraudDetection(conn, {
          eventId: activeEventId,
          passId: null,
          passCode: cleanCode,
          actualPassEventId: null,
          scannerUserId: operatorId,
          scannerUserName: operatorName,
          detectionType: 'PASS_NOT_FOUND',
          reason: 'This pass is not registered for this event.',
          deviceId,
          ipAddress,
          detectedAt: sqlScanTime
        });

        return {
          success: false,
          result: 'fraud',
          fraudType: 'PASS_NOT_FOUND',
          message: '✕ FRAUD DETECTION — Pass not registered for this event',
          reason: 'This pass is not registered for this event.',
          passCode: cleanCode,
          detectedAt: sqlScanTime
        };
      }

      const pass = passes[0];
      const passEventId = pass.resolved_event_id || pass.event_id;
      const categoryId = pass.resolved_category_id || pass.category_id;

      // =========================================================================
      // FRAUD CASE 2: Cross-Event Mismatch (Pass belongs to another event)
      // SuperAdmin has global authority and is exempt from cross-event rejection
      // =========================================================================
      const isSuperAdmin = operatorRole === 'SUPERADMIN';
      if (!isSuperAdmin && activeEventId && passEventId && Number(activeEventId) !== Number(passEventId)) {
        const fraudReason = `This pass belongs to another event (${pass.event_name || 'Event #' + passEventId}).`;
        const fraudMsg = `⚠ OTHER EVENT PASS — This pass belongs to '${pass.event_name || 'Event #' + passEventId}'`;

        await conn.query(
          `INSERT INTO scan_history (event_id, category_id, pass_id, pass_code, pass_type, device_id, operator_id, scan_time, result, reason, ip_address)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'invalid', ?, ?)`,
          [activeEventId, categoryId, pass.id, pass.code, pass.code_type, deviceId, operatorId, sqlScanTime, fraudReason, ipAddress]
        );

        // Record confirmed Fraud Detection: WRONG_EVENT
        await recordFraudDetection(conn, {
          eventId: activeEventId,
          passId: pass.id,
          passCode: cleanCode,
          actualPassEventId: passEventId,
          scannerUserId: operatorId,
          scannerUserName: operatorName,
          detectionType: 'WRONG_EVENT',
          reason: fraudReason,
          deviceId,
          ipAddress,
          detectedAt: sqlScanTime
        });

        return {
          success: false,
          result: 'fraud',
          fraudType: 'WRONG_EVENT',
          message: fraudMsg,
          reason: fraudReason,
          passCode: cleanCode,
          event: formatEventPayload(pass),
          detectedAt: sqlScanTime
        };
      }

      // Event Status check
      if (pass.event_status === 'inactive' || pass.event_status === 'completed') {
        const msg = `Event '${pass.event_name}' is not currently active.`;
        await conn.query(
          `INSERT INTO scan_history (event_id, category_id, pass_id, pass_code, pass_type, device_id, operator_id, scan_time, result, reason, ip_address)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'invalid', ?, ?)`,
          [passEventId, categoryId, pass.id, pass.code, pass.code_type, deviceId, operatorId, sqlScanTime, msg, ipAddress]
        );

        return {
          success: false,
          result: 'invalid',
          message: msg,
          passCode: cleanCode,
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
          [passEventId, categoryId, pass.id, pass.code, pass.code_type, deviceId, operatorId, sqlScanTime, ipAddress]
        );

        return {
          success: false,
          result: 'invalid',
          message: await getMessage('INVALID_CODE', 'Pass signature is invalid or tampered with'),
          passCode: cleanCode
        };
      }

      // 4. Check if pass is Voided
      if (pass.status === 'void') {
        const msg = await getMessage('PASS_VOIDED', 'This pass is voided and invalid. Entry denied.');
        await conn.query(
          `INSERT INTO scan_history (event_id, category_id, pass_id, pass_code, pass_type, device_id, operator_id, scan_time, result, reason, ip_address)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'voided', ?, ?)`,
          [passEventId, categoryId, pass.id, pass.code, pass.code_type, deviceId, operatorId, sqlScanTime, msg, ipAddress]
        );

        return {
          success: false,
          result: 'voided',
          message: msg,
          passCode: cleanCode,
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
          [passEventId, categoryId, pass.id, pass.code, pass.code_type, deviceId, operatorId, sqlScanTime, msg, ipAddress]
        );

        return {
          success: false,
          result: 'wrong_date',
          message: msg,
          passCode: cleanCode,
          event: formatEventPayload(pass),
          category: formatCategoryPayload(pass),
          pass: formatPassPayload(pass)
        };
      }

      if (validityStatus === 'expired' || pass.status === 'expired') {
        const untilDateFormatted = formatDateIST(pass.valid_until);
        const defaultMsg = `This pass expired on ${untilDateFormatted}. Entry denied.`;
        const msg = (await getMessage('PASS_EXPIRED', defaultMsg)).replace('{date}', untilDateFormatted);

        await conn.query(
          'UPDATE passes SET status = "expired", last_scanned_at = ?, updated_at = NOW() WHERE id = ?',
          [sqlScanTime, pass.id]
        );

        await conn.query(
          `INSERT INTO scan_history (event_id, category_id, pass_id, pass_code, pass_type, device_id, operator_id, scan_time, result, reason, ip_address)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'expired', ?, ?)`,
          [passEventId, categoryId, pass.id, pass.code, pass.code_type, deviceId, operatorId, sqlScanTime, msg, ipAddress]
        );

        const consumedCount = (pass.status === 'used' || pass.first_scanned_at) ? Math.max(1, pass.scan_count || 1) : (pass.scan_count || 0);

        return {
          success: false,
          result: 'expired',
          message: msg,
          passCode: cleanCode,
          scanCount: consumedCount,
          checkpointLimit: 1,
          firstScannedAt: toIsoUtcString(pass.first_scanned_at),
          firstScannedAtIST: formatDateTimeIST(pass.first_scanned_at),
          lastScannedAt: toIsoUtcString(sqlScanTime),
          lastScannedAtIST: formatDateTimeIST(sqlScanTime),
          event: formatEventPayload(pass),
          category: formatCategoryPayload(pass),
          pass: {
            ...formatPassPayload(pass),
            scanCount: consumedCount,
            scan_count: consumedCount,
            firstScannedAt: toIsoUtcString(pass.first_scanned_at),
            firstScannedAtIST: formatDateTimeIST(pass.first_scanned_at),
            lastScannedAt: toIsoUtcString(sqlScanTime),
            lastScannedAtIST: formatDateTimeIST(sqlScanTime)
          }
        };
      }

      // =========================================================================
      // DYNAMIC CHECKPOINT SCANNING (e.g. Entry, Breakfast, Lunch, Snacks, Dinner)
      // =========================================================================
      if (checkpointId) {
        const [checkpointRows] = await conn.query(
          'SELECT * FROM scan_checkpoints WHERE id = ? AND event_id = ? FOR UPDATE',
          [checkpointId, passEventId]
        );

        if (!checkpointRows || checkpointRows.length === 0) {
          const invalidChkMsg = 'Scan checkpoint not found or does not belong to this event.';
          await conn.query(
            `INSERT INTO scan_history (event_id, category_id, checkpoint_id, pass_id, pass_code, pass_type, device_id, operator_id, scan_time, result, reason, ip_address)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'invalid', ?, ?)`,
            [passEventId, categoryId, checkpointId, pass.id, pass.code, pass.code_type, deviceId, operatorId, sqlScanTime, invalidChkMsg, ipAddress]
          );

          return {
            success: false,
            result: 'invalid',
            message: invalidChkMsg,
            passCode: cleanCode
          };
        }

        const checkpoint = checkpointRows[0];
        if (!checkpoint.is_active) {
          const inactiveMsg = `Checkpoint '${checkpoint.name}' is currently disabled.`;
          return {
            success: false,
            result: 'invalid',
            message: inactiveMsg,
            passCode: cleanCode
          };
        }

        // Check if checkpoint restricts categories
        if (checkpoint.allowed_categories) {
          const allowed = typeof checkpoint.allowed_categories === 'string' ? JSON.parse(checkpoint.allowed_categories) : checkpoint.allowed_categories;
          if (Array.isArray(allowed) && allowed.length > 0) {
            const catMatch = allowed.includes(categoryId) || allowed.includes(Number(categoryId)) || allowed.includes(pass.code_type);
            if (!catMatch) {
              const catDenyMsg = `This pass (${pass.category_name || pass.code_type}) is not authorized for '${checkpoint.name}'.`;
              await conn.query(
                `INSERT INTO scan_history (event_id, category_id, checkpoint_id, pass_id, pass_code, pass_type, device_id, operator_id, scan_time, result, reason, ip_address)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'invalid', ?, ?)`,
                [passEventId, categoryId, checkpoint.id, pass.id, pass.code, pass.code_type, deviceId, operatorId, sqlScanTime, catDenyMsg, ipAddress]
              );

              return {
                success: false,
                result: 'invalid',
                message: catDenyMsg,
                passCode: cleanCode,
                checkpoint: { id: checkpoint.id, name: checkpoint.name, code: checkpoint.code },
                event: formatEventPayload(pass),
                category: formatCategoryPayload(pass),
                pass: formatPassPayload(pass)
              };
            }
          }
        }

        // Check prior approved scans at THIS checkpoint
        const [chkScans] = await conn.query(
          `SELECT COUNT(*) as scan_count, MAX(scan_time) as last_scan
           FROM scan_history
           WHERE pass_id = ? AND checkpoint_id = ? AND result = 'approved'`,
          [pass.id, checkpoint.id]
        );

        const chkScanCount = chkScans[0]?.scan_count || 0;
        const maxScans = checkpoint.max_scans_per_pass || 1;

        if (chkScanCount >= maxScans) {
          const lastScanFormatted = chkScans[0]?.last_scan ? formatDateTimeIST(chkScans[0].last_scan) : 'earlier';
          const reason = `Already scanned at '${checkpoint.name}' at ${lastScanFormatted} (Limit: ${maxScans}).`;
          const msg = `Already Scanned — ${checkpoint.name}`;

          await conn.query(
            `INSERT INTO scan_history (event_id, category_id, checkpoint_id, pass_id, pass_code, pass_type, device_id, operator_id, scan_time, result, reason, ip_address)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'already_used', ?, ?)`,
            [passEventId, categoryId, checkpoint.id, pass.id, pass.code, pass.code_type, deviceId, operatorId, sqlScanTime, reason, ipAddress]
          );

          // Update passes.last_scanned_at to record this latest scan attempt (first_scanned_at remains fixed)
          await conn.query(
            'UPDATE passes SET last_scanned_at = ?, updated_at = NOW() WHERE id = ?',
            [sqlScanTime, pass.id]
          );

          return {
            success: false,
            result: 'already_used',
            message: msg,
            reason: reason,
            passCode: cleanCode,
            checkpoint: { id: checkpoint.id, name: checkpoint.name, code: checkpoint.code },
            scanCount: chkScanCount,
            checkpointLimit: maxScans,
            firstScannedAt: toIsoUtcString(pass.first_scanned_at),
            firstScannedAtIST: formatDateTimeIST(pass.first_scanned_at),
            lastScannedAt: toIsoUtcString(sqlScanTime),
            lastScannedAtIST: formatDateTimeIST(sqlScanTime),
            event: formatEventPayload(pass),
            category: formatCategoryPayload(pass),
            pass: {
              ...formatPassPayload(pass),
              scanCount: chkScanCount,
              scan_count: chkScanCount,
              firstScannedAt: toIsoUtcString(pass.first_scanned_at),
              firstScannedAtIST: formatDateTimeIST(pass.first_scanned_at),
              lastScannedAt: toIsoUtcString(sqlScanTime),
              lastScannedAtIST: formatDateTimeIST(sqlScanTime)
            }
          };
        }

        // Approve checkpoint scan
        const isFirstScan = !pass.first_scanned_at;
        const firstScanUtc = isFirstScan ? sqlScanTime : pass.first_scanned_at;
        await conn.query(
          `UPDATE passes
           SET scan_count = scan_count + 1,
               first_scanned_at = COALESCE(first_scanned_at, ?),
               last_scanned_at = ?,
               updated_at = NOW()
           WHERE id = ?`,
          [sqlScanTime, sqlScanTime, pass.id]
        );

        const approvedMsg = `✓ ${checkpoint.name} Approved`;
        await conn.query(
          `INSERT INTO scan_history (event_id, category_id, checkpoint_id, pass_id, pass_code, pass_type, device_id, operator_id, scan_time, result, reason, ip_address)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?)`,
          [passEventId, categoryId, checkpoint.id, pass.id, pass.code, pass.code_type, deviceId, operatorId, sqlScanTime, `${checkpoint.name} Entry Approved`, ipAddress]
        );

        return {
          success: true,
          result: 'approved',
          message: approvedMsg,
          passCode: cleanCode,
          checkpoint: { id: checkpoint.id, name: checkpoint.name, code: checkpoint.code },
          scanCount: chkScanCount + 1,
          checkpointLimit: maxScans,
          firstScannedAt: toIsoUtcString(firstScanUtc),
          firstScannedAtIST: formatDateTimeIST(firstScanUtc),
          lastScannedAt: toIsoUtcString(sqlScanTime),
          lastScannedAtIST: formatDateTimeIST(sqlScanTime),
          event: formatEventPayload(pass),
          category: formatCategoryPayload(pass),
          pass: {
            ...formatPassPayload(pass),
            scanCount: (pass.scan_count || 0) + 1,
            scan_count: (pass.scan_count || 0) + 1,
            firstScannedAt: toIsoUtcString(firstScanUtc),
            firstScannedAtIST: formatDateTimeIST(firstScanUtc),
            lastScannedAt: toIsoUtcString(sqlScanTime),
            lastScannedAtIST: formatDateTimeIST(sqlScanTime)
          }
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
            [passEventId, categoryId, pass.id, pass.code, pass.code_type, deviceId, operatorId, sqlScanTime, reason, ipAddress]
          );

          // Update passes.last_scanned_at to record this latest scan attempt (first_scanned_at stays fixed!)
          await conn.query(
            `UPDATE passes SET last_scanned_at = ?, updated_at = NOW() WHERE id = ?`,
            [sqlScanTime, pass.id]
          );

          const consumedCount = Math.max(1, pass.scan_count || 1);

          return {
            success: false,
            result: 'already_used',
            message: msg,
            reason: reason,
            passCode: cleanCode,
            scanCount: consumedCount,
            checkpointLimit: 1,
            firstScannedAt: toIsoUtcString(originalScanDate),
            firstScannedAtIST: formatDateTimeIST(originalScanDate),
            lastScannedAt: toIsoUtcString(sqlScanTime),
            lastScannedAtIST: formatDateTimeIST(sqlScanTime),
            event: formatEventPayload(pass),
            category: formatCategoryPayload(pass),
            pass: {
              ...formatPassPayload(pass),
              scanCount: consumedCount,
              scan_count: consumedCount,
              firstScannedAt: toIsoUtcString(originalScanDate),
              firstScannedAtIST: formatDateTimeIST(originalScanDate),
              lastScannedAt: toIsoUtcString(sqlScanTime),
              lastScannedAtIST: formatDateTimeIST(sqlScanTime)
            }
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
          [passEventId, categoryId, pass.id, pass.code, pass.code_type, deviceId, operatorId, sqlScanTime, 'One-Time Pass Entry Approved', ipAddress]
        );

        return {
          success: true,
          result: 'approved',
          message: msg,
          passCode: cleanCode,
          scanCount: 1,
          checkpointLimit: 1,
          firstScannedAt: toIsoUtcString(sqlScanTime),
          firstScannedAtIST: formatDateTimeIST(sqlScanTime),
          lastScannedAt: toIsoUtcString(sqlScanTime),
          lastScannedAtIST: formatDateTimeIST(sqlScanTime),
          event: formatEventPayload(pass),
          category: formatCategoryPayload(pass),
          pass: {
            ...formatPassPayload(pass),
            status: 'used',
            scanCount: 1,
            scan_count: 1,
            firstScannedAt: toIsoUtcString(sqlScanTime),
            firstScannedAtIST: formatDateTimeIST(sqlScanTime),
            lastScannedAt: toIsoUtcString(sqlScanTime),
            lastScannedAtIST: formatDateTimeIST(sqlScanTime)
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
          [passEventId, categoryId, pass.id, pass.code, pass.code_type, deviceId, operatorId, sqlScanTime, msg, ipAddress]
        );

        return {
          success: false,
          result: 'expired',
          message: msg,
          passCode: cleanCode,
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
          [passEventId, categoryId, pass.id, pass.code, pass.code_type, deviceId, operatorId, sqlScanTime, msg, ipAddress]
        );

        return {
          success: false,
          result: 'wrong_date',
          message: msg,
          passCode: cleanCode,
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
          [passEventId, categoryId, pass.id, pass.code, pass.code_type, deviceId, operatorId, sqlScanTime, reason, ipAddress]
        );

        // Update passes.last_scanned_at to record this latest scan attempt
        await conn.query(
          `UPDATE passes SET last_scanned_at = ?, updated_at = NOW() WHERE id = ?`,
          [sqlScanTime, pass.id]
        );

        const consumedCount = Math.max(1, pass.scan_count || 1);

        return {
          success: false,
          result: 'already_used',
          message: msg,
          reason,
          passCode: cleanCode,
          scanCount: consumedCount,
          checkpointLimit: pass.max_daily_scans || 1,
          firstScannedAt: toIsoUtcString(pass.first_scanned_at || pass.last_scanned_at),
          firstScannedAtIST: formatDateTimeIST(pass.first_scanned_at || pass.last_scanned_at),
          lastScannedAt: toIsoUtcString(sqlScanTime),
          lastScannedAtIST: formatDateTimeIST(sqlScanTime),
          event: formatEventPayload(pass),
          category: formatCategoryPayload(pass),
          pass: {
            ...formatPassPayload(pass),
            scanCount: consumedCount,
            scan_count: consumedCount,
            firstScannedAt: toIsoUtcString(pass.first_scanned_at || pass.last_scanned_at),
            firstScannedAtIST: formatDateTimeIST(pass.first_scanned_at || pass.last_scanned_at),
            lastScannedAt: toIsoUtcString(sqlScanTime),
            lastScannedAtIST: formatDateTimeIST(sqlScanTime)
          }
        };
      }

      // Approve Renewable Pass for current shift/cycle
      const isFirstScan = !pass.first_scanned_at;
      const firstScanUtc = isFirstScan ? sqlScanTime : pass.first_scanned_at;
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
        [passEventId, categoryId, pass.id, pass.code, pass.code_type, deviceId, operatorId, sqlScanTime, `Renewable Pass Entry Approved (Cycle: ${formatTimeIST(renewalTimeStr)})`, ipAddress]
      );

      return {
        success: true,
        result: 'approved',
        message: approvedMsg,
        passCode: cleanCode,
        scanCount: (pass.scan_count || 0) + 1,
        checkpointLimit: pass.max_daily_scans || 1,
        firstScannedAt: toIsoUtcString(firstScanUtc),
        firstScannedAtIST: formatDateTimeIST(firstScanUtc),
        lastScannedAt: toIsoUtcString(sqlScanTime),
        lastScannedAtIST: formatDateTimeIST(sqlScanTime),
        event: formatEventPayload(pass),
        category: formatCategoryPayload(pass),
        pass: {
          ...formatPassPayload(pass),
          scanCount: (pass.scan_count || 0) + 1,
          scan_count: (pass.scan_count || 0) + 1,
          firstScannedAt: toIsoUtcString(firstScanUtc),
          firstScannedAtIST: formatDateTimeIST(firstScanUtc),
          lastScannedAt: toIsoUtcString(sqlScanTime),
          lastScannedAtIST: formatDateTimeIST(sqlScanTime)
        }
      };
    });

    return scanResult;
  } finally {
    await lock.release();
  }
}

/**
 * Get Fraud Detections summary statistics and recent logs in IST
 */
async function getFraudStats({ eventId = null } = {}) {
  const eventWhere = eventId ? 'WHERE fd.event_id = ?' : '';
  const eventParams = eventId ? [parseInt(eventId, 10)] : [];

  const [totalRes] = await query(
    `SELECT COUNT(*) as total FROM fraud_detections fd ${eventWhere}`,
    eventParams
  );

  const [todayRes] = await query(
    `SELECT COUNT(*) as today_total FROM fraud_detections fd 
     WHERE DATE(fd.detected_at) = CURRENT_DATE() ${eventId ? 'AND fd.event_id = ?' : ''}`,
    eventParams
  );

  const recent = await query(
    `SELECT fd.*, e.event_name, ae.event_name as actual_event_name
     FROM fraud_detections fd
     LEFT JOIN events e ON fd.event_id = e.id
     LEFT JOIN events ae ON fd.actual_pass_event_id = ae.id
     ${eventWhere}
     ORDER BY fd.detected_at DESC
     LIMIT 20`,
    eventParams
  );

  return {
    totalFraudCount: totalRes?.total || 0,
    todayFraudCount: todayRes?.today_total || 0,
    recentFraudDetections: recent.map(r => ({
      id: r.id,
      passCode: r.scanned_pass_code,
      passId: r.pass_id,
      eventId: r.event_id,
      eventName: r.event_name || 'Assigned Event',
      actualPassEventId: r.actual_pass_event_id,
      actualPassEventName: r.actual_event_name || 'External Event',
      detectionType: r.detection_type,
      reason: r.reason,
      scannerUserId: r.scanner_user_id,
      scannerUserName: r.scanner_user_name,
      deviceId: r.device_id,
      detectedAt: r.detected_at,
      detectedAtIST: formatDateTimeIST(r.detected_at)
    }))
  };
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
  const firstScannedAt = pass.first_scanned_at ? toIsoUtcString(pass.first_scanned_at) : null;
  const lastScannedAt = pass.last_scanned_at ? toIsoUtcString(pass.last_scanned_at) : null;
  const scanCount = pass.scan_count || 0;
  return {
    id: pass.id,
    code: pass.code,
    type: pass.code_type,
    categoryName: pass.category_name || pass.code_type,
    status: pass.status,
    validFrom: pass.valid_from,
    validUntil: pass.valid_until,
    printed: Boolean(pass.printed),
    firstScannedAt,
    firstScannedAtIST: formatDateTimeIST(pass.first_scanned_at),
    lastScannedAt,
    lastScannedAtIST: formatDateTimeIST(pass.last_scanned_at),
    scanCount,
    scan_count: scanCount
  };
}

module.exports = {
  processScan,
  getFraudStats
};
