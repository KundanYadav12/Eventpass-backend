const { query, withTransaction } = require('../config/db');
const { getCommandGenerator } = require('../utils/commandLanguages');
const { getSettings, getAllAvailablePrinters } = require('./PrinterConfigService');
const { enqueueJob } = require('./PrintGatewayService');
const { listPrinters, getPrinterStatus, getDetailedPrinterDiagnostics, printRawTspl, DEFAULT_PRINTER_NAME } = require('../utils/printerDriver');
const { generatePassCode, generateHmacSignature } = require('../utils/cryptoUtil');
const { logAudit } = require('./AuditService');

/**
 * List all print batches with progress metrics
 */
async function getPrintBatches({ eventId = null, status = 'all', page = 1, limit = 20 } = {}) {
  const offset = (page - 1) * limit;
  const whereClauses = [];
  const params = [];

  if (eventId) {
    whereClauses.push('pb.event_id = ?');
    params.push(eventId);
  }

  if (status !== 'all') {
    whereClauses.push('pb.status = ?');
    params.push(status);
  }

  const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

  const [countResult] = await query(
    `SELECT COUNT(*) as total FROM print_batches pb ${whereSql}`,
    params
  );
  const total = countResult ? countResult.total : 0;

  const batches = await query(
    `SELECT pb.*, 
            COALESCE(NULLIF(pb.total_requested, 0), (SELECT COUNT(*) FROM passes WHERE print_batch_id = pb.id), 0) as quantity,
            COALESCE(NULLIF(pb.total_requested, 0), (SELECT COUNT(*) FROM passes WHERE print_batch_id = pb.id), 0) as total_requested,
            (SELECT COUNT(*) FROM passes WHERE print_batch_id = pb.id AND printed = 1) as actual_printed_count,
            u.name as created_by_name, c.name as category_name, e.event_name
     FROM print_batches pb
     LEFT JOIN users u ON pb.created_by = u.id
     LEFT JOIN pass_categories c ON pb.category_id = c.id
     LEFT JOIN events e ON pb.event_id = e.id
     ${whereSql}
     ORDER BY pb.id DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  return {
    batches,
    pagination: {
      page: Number(page),
      limit: Number(limit),
      totalRecords: total,
      totalPages: Math.ceil(total / limit) || 1
    }
  };
}

/**
 * Create a new print batch linked to an event and category
 * Auto-generates unique 7-character passes if existing inventory is exhausted
 */
async function createPrintBatch({ eventId, categoryId, name, quantity, passType = null, barcodePattern = 'QR_CODE' }, { userId, userName, ipAddress, userAgent } = {}) {
  const result = await withTransaction(async (conn) => {
    let targetEventId = eventId;
    let targetCatId = categoryId;

    if (!targetCatId && passType) {
      const [cats] = await conn.query('SELECT id, event_id FROM pass_categories WHERE code = ? LIMIT 1', [passType]);
      if (cats.length > 0) {
        targetCatId = cats[0].id;
        targetEventId = targetEventId || cats[0].event_id;
      }
    }

    if (!targetCatId) {
      throw new Error('Pass Category is required to create a print batch');
    }

    // Select existing unprinted active passes for this category & event
    const [existingPasses] = await conn.query(
      `SELECT p.id, p.code, p.code_type, p.valid_from, p.valid_until
       FROM passes p
       WHERE p.category_id = ? AND (p.event_id = ? OR ? IS NULL) AND p.printed = 0 AND p.status = 'active'
       ORDER BY p.id ASC
       LIMIT ?
       FOR UPDATE`,
      [targetCatId, targetEventId, targetEventId, quantity]
    );

    let passesToUse = [...existingPasses];

    // If unprinted passes is less than requested quantity, auto-generate fresh unique 7-character passes
    const needed = quantity - passesToUse.length;
    if (needed > 0) {
      const [catRows] = await conn.query('SELECT * FROM pass_categories WHERE id = ?', [targetCatId]);
      if (catRows.length === 0) throw new Error('Target pass category not found');
      const cat = catRows[0];
      const evId = targetEventId || cat.event_id;

      const validFrom = cat.valid_from || new Date();
      const validUntil = cat.valid_until || new Date(Date.now() + 30 * 24 * 3600 * 1000);

      for (let i = 0; i < needed; i++) {
        let uniqueCodeFound = false;
        let newCode = '';
        let attempts = 0;

        while (!uniqueCodeFound && attempts < 10) {
          attempts++;
          newCode = generatePassCode();
          const [dup] = await conn.query('SELECT id FROM passes WHERE code = ?', [newCode]);
          if (dup.length === 0) uniqueCodeFound = true;
        }

        if (!uniqueCodeFound) {
          throw new Error('Failed to generate collision-free unique pass code');
        }

        const hmac = generateHmacSignature(newCode);

        const [insResult] = await conn.query(
          `INSERT INTO passes (event_id, category_id, code, hmac_sig, code_type, category_prefix, status, printed, valid_from, valid_until, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'active', 0, ?, ?, NOW(), NOW())`,
          [evId, targetCatId, newCode, hmac, cat.code || 'PASS', cat.category_prefix || '', validFrom, validUntil]
        );

        passesToUse.push({
          id: insResult.insertId,
          code: newCode,
          code_type: cat.code || 'PASS',
          valid_from: validFrom,
          valid_until: validUntil
        });
      }
    }

    if (passesToUse.length === 0) {
      throw new Error('No unprinted passes available to allocate for this print batch');
    }

    const resolvedPassType = passesToUse[0]?.code_type || 'PASS';
    const targetPattern = (barcodePattern || 'QR_CODE').toUpperCase();
    const [batchResult] = await conn.query(
      `INSERT INTO print_batches (event_id, category_id, name, pass_type, barcode_pattern, total_requested, printed_count, status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, 'created', ?, NOW(), NOW())`,
      [targetEventId, targetCatId, name || `Batch-${new Date().toISOString().slice(0, 10)}`, resolvedPassType, targetPattern, passesToUse.length, userId]
    );

    const batchId = batchResult.insertId;
    const passIds = passesToUse.map(p => p.id);

    // Bind passes to this print batch
    await conn.query(
      `UPDATE passes SET print_batch_id = ?, updated_at = NOW() WHERE id IN (${passIds.map(() => '?').join(',')})`,
      [batchId, ...passIds]
    );

    // Audit log
    await conn.query(
      `INSERT INTO audit_log (event_id, user_id, user_name, action, entity, entity_id, new_value, ip_address, user_agent, created_at)
       VALUES (?, ?, ?, 'CREATE_PRINT_BATCH', 'PRINT_BATCH', ?, ?, ?, ?, NOW())`,
      [
        targetEventId,
        userId,
        userName,
        String(batchId),
        JSON.stringify({ name, quantity: passesToUse.length, categoryId: targetCatId, eventId: targetEventId }),
        ipAddress,
        userAgent
      ]
    );

    return {
      batchId,
      name,
      allocatedPasses: passesToUse.length,
      status: 'created'
    };
  });

  return result;
}

/**
 * Reprint an existing print batch:
 * Generates fresh unique 7-character pass codes & HMAC signatures for all passes in the batch
 */
async function reprintBatch(batchId, { userId, userName, ipAddress, userAgent } = {}) {
  const result = await withTransaction(async (conn) => {
    const [batchRows] = await conn.query('SELECT * FROM print_batches WHERE id = ? FOR UPDATE', [batchId]);
    if (batchRows.length === 0) throw new Error('Batch not found');
    const batch = batchRows[0];

    const [passes] = await conn.query(
      'SELECT id, code FROM passes WHERE print_batch_id = ? ORDER BY id ASC FOR UPDATE',
      [batchId]
    );

    if (passes.length === 0) {
      throw new Error('No passes linked to this print batch');
    }

    // Regenerate each pass with a brand new unique 7-character code and HMAC signature
    for (const pass of passes) {
      let uniqueCodeFound = false;
      let newCode = '';
      let attempts = 0;

      while (!uniqueCodeFound && attempts < 10) {
        attempts++;
        newCode = generatePassCode();
        const [existing] = await conn.query('SELECT id FROM passes WHERE code = ?', [newCode]);
        if (existing.length === 0) {
          uniqueCodeFound = true;
        }
      }

      if (!uniqueCodeFound) {
        throw new Error('Could not generate unique pass code collision-free');
      }

      const newHmac = generateHmacSignature(newCode);

      await conn.query(
        `UPDATE passes
         SET code = ?,
             hmac_sig = ?,
             status = 'active',
             printed = 0,
             scan_count = 0,
             first_scanned_at = NULL,
             last_scanned_at = NULL,
             updated_at = NOW()
         WHERE id = ?`,
        [newCode, newHmac, pass.id]
      );
    }

    // Reset batch status to created, printed_count = 0
    await conn.query(
      `UPDATE print_batches
       SET status = 'created',
           printed_count = 0,
           started_at = NULL,
           completed_at = NULL,
           updated_at = NOW()
       WHERE id = ?`,
      [batchId]
    );

    // Audit log
    await conn.query(
      `INSERT INTO audit_log (event_id, user_id, user_name, action, entity, entity_id, new_value, ip_address, user_agent, created_at)
       VALUES (?, ?, ?, 'REPRINT_PRINT_BATCH', 'PRINT_BATCH', ?, ?, ?, ?, NOW())`,
      [
        batch.event_id,
        userId,
        userName,
        String(batchId),
        JSON.stringify({ message: `Regenerated ${passes.length} unique pass codes for reprint` }),
        ipAddress,
        userAgent
      ]
    );

    return {
      batchId,
      totalPasses: passes.length,
      status: 'created',
      message: `Batch #${batchId} successfully reset with ${passes.length} new unique pass codes for reprint.`
    };
  });

  return result;
}

/**
 * Get batch details with passes list
 */
async function getBatchDetails(batchId) {
  const batches = await query(
    `SELECT pb.*, 
            COALESCE(NULLIF(pb.total_requested, 0), (SELECT COUNT(*) FROM passes WHERE print_batch_id = pb.id), 0) as quantity,
            COALESCE(NULLIF(pb.total_requested, 0), (SELECT COUNT(*) FROM passes WHERE print_batch_id = pb.id), 0) as total_requested,
            (SELECT COUNT(*) FROM passes WHERE print_batch_id = pb.id AND printed = 1) as actual_printed_count,
            u.name as created_by_name, c.name as category_name, e.event_name
     FROM print_batches pb
     LEFT JOIN users u ON pb.created_by = u.id
     LEFT JOIN pass_categories c ON pb.category_id = c.id
     LEFT JOIN events e ON pb.event_id = e.id
     WHERE pb.id = ?`,
    [batchId]
  );

  if (batches.length === 0) return null;

  const batch = batches[0];
  const passes = await query(
    `SELECT id, code, code_type, status, printed, valid_from, valid_until
     FROM passes
     WHERE print_batch_id = ?
     ORDER BY id ASC`,
    [batchId]
  );

  return {
    batch,
    passes,
    remainingCount: Math.max(0, batch.total_requested - batch.printed_count)
  };
}

/**
 * Process chunk printing (marks passes printed and sends commands directly or to Gateway Queue)
 */
async function processBatchChunk(batchId, chunkSize = 50, printerName = null, { userId, userName, ipAddress, userAgent, spoolOnServer = false } = {}) {
  const batchRows = await query('SELECT * FROM print_batches WHERE id = ?', [batchId]);
  if (!batchRows || batchRows.length === 0) throw new Error('Batch not found');
  const batch = batchRows[0];

  // 1. Get dynamic settings
  const settings = await getSettings(batch.event_id);
  const activePrinter = printerName || settings.printer_name || DEFAULT_PRINTER_NAME;
  const generator = getCommandGenerator(settings.command_language);

  // 2. If running locally on server and server-side spooling is enabled, verify physical printer
  if (!settings.gateway_mode && spoolOnServer) {
    const printerStatus = await getPrinterStatus(activePrinter);
    if (printerStatus.isOutOfStock) {
      await query(
        'UPDATE print_batches SET status = "paused_out_of_stock", updated_at = NOW() WHERE id = ?',
        [batchId]
      );
      throw new Error(`Printer Stock Error: ${printerStatus.message}. Batch paused as 'paused_out_of_stock'.`);
    }
  }

  return await withTransaction(async (conn) => {
    const [freshBatch] = await conn.query('SELECT * FROM print_batches WHERE id = ? FOR UPDATE', [batchId]);
    if (freshBatch.length === 0) throw new Error('Batch not found');
    const curBatch = freshBatch[0];

    if (curBatch.status === 'cancelled') throw new Error('Batch has been cancelled');
    if (curBatch.status === 'completed') throw new Error('Batch is already completed');

    const [unprintedPasses] = await conn.query(
      `SELECT p.id, p.code, p.code_type, p.valid_from, p.valid_until,
              c.name as category_name, e.event_name
       FROM passes p
       LEFT JOIN pass_categories c ON p.category_id = c.id
       LEFT JOIN events e ON p.event_id = e.id
       WHERE p.print_batch_id = ? AND p.printed = 0
       ORDER BY p.id ASC
       LIMIT ?
       FOR UPDATE`,
      [batchId, chunkSize]
    );

    if (unprintedPasses.length === 0) {
      await conn.query('UPDATE print_batches SET status = "completed", completed_at = NOW() WHERE id = ?', [batchId]);
      return { status: 'completed', printedNow: 0, totalPrinted: curBatch.printed_count, remaining: 0 };
    }

    const passIds = unprintedPasses.map(p => p.id);

    const formattedPasses = unprintedPasses.map(p => ({
      code: p.code,
      category_name: p.category_name,
      event_name: p.event_name,
      valid_date_label: new Date(p.valid_from).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
    }));

    // 3. Generate Pluggable Command Payload (TSPL / ZPL)
    const payload = generator.generateBatch(formattedPasses, {
      pattern: curBatch.barcode_pattern || settings.barcode_type || 'QR_CODE',
      widthMm: settings.stock_width_mm || 38,
      heightMm: settings.stock_height_mm || 50,
      gapMm: settings.gap_mm,
      speed: settings.speed,
      density: settings.density,
      direction: settings.direction,
      dualColumn: Boolean(settings.dual_column)
    });

    // 4. Dispatch to Gateway Queue OR Direct Spooler
    if (settings.gateway_mode) {
      await enqueueJob({
        batchId,
        jobType: 'batch_chunk',
        printerName: activePrinter,
        commandLanguage: settings.command_language,
        passIds,
        rawPayload: payload,
        totalLabels: unprintedPasses.length,
        userId
      });

      return {
        status: 'queued_for_gateway',
        gatewayMode: true,
        printerName: activePrinter,
        commandLanguage: settings.command_language,
        printedNow: unprintedPasses.length,
        message: `${unprintedPasses.length} passes queued for Local Windows Gateway processing on printer '${activePrinter}'.`
      };
    }

    // Direct Spooling mode (only if spoolOnServer is explicitly true)
    if (spoolOnServer) {
      try {
        await printRawTspl(activePrinter, payload, `Batch_${batchId}_Chunk_${unprintedPasses.length}`);
      } catch (spoolError) {
        await conn.query(
          'UPDATE print_batches SET status = "paused_out_of_stock", updated_at = NOW() WHERE id = ?',
          [batchId]
        );
        throw new Error(`Printer Spooler Error: ${spoolError.message}. Batch marked as paused_out_of_stock.`);
      }
    }

    // Mark passes as printed ONLY AFTER successful spooling
    await conn.query(
      `UPDATE passes SET printed = 1, updated_at = NOW() WHERE id IN (${passIds.map(() => '?').join(',')})`,
      passIds
    );

    // Bulk insert print_log
    const logValues = unprintedPasses.map(p => [batchId, p.id, activePrinter, 'success']);
    const logPlaceholders = logValues.map(() => '(?, ?, NOW(), ?, ?)').join(',');
    await conn.query(
      `INSERT INTO print_log (batch_id, pass_id, printed_at, printer_name, status) VALUES ${logPlaceholders}`,
      logValues.flat()
    );

    const newPrintedCount = curBatch.printed_count + unprintedPasses.length;
    const isFinished = newPrintedCount >= curBatch.total_requested;
    const newStatus = isFinished ? 'completed' : 'printing';

    await conn.query(
      `UPDATE print_batches
       SET printed_count = ?,
           status = ?,
           started_at = COALESCE(started_at, NOW()),
           completed_at = IF(? = 1, NOW(), completed_at),
           updated_at = NOW()
       WHERE id = ?`,
      [newPrintedCount, newStatus, isFinished ? 1 : 0, batchId]
    );

    return {
      batchId: curBatch.id,
      status: newStatus,
      printedNow: unprintedPasses.length,
      printedInThisChunk: unprintedPasses.length,
      totalPrinted: newPrintedCount,
      totalPrintedSoFar: newPrintedCount,
      totalQuantity: curBatch.total_requested,
      quantity: curBatch.total_requested,
      isCompleted: isFinished,
      remaining: Math.max(0, curBatch.total_requested - newPrintedCount),
      tsplData: payload,
      rawPayload: payload,
      passes: unprintedPasses.map(p => ({
        id: p.id,
        code: p.code,
        categoryName: p.category_name,
        category_name: p.category_name,
        eventName: p.event_name,
        event_name: p.event_name,
        barcode_pattern: curBatch.barcode_pattern || 'QR_CODE'
      }))
    };
  });
}

/**
 * Print Exactly ONE Physical Barcode/QR Test Label (38mm x 50mm)
 * Uses active printer settings and selected command language
 */
async function printSingleBarcodeTest(printerName = null, barcodeValue = '55KDBD2', { eventName = 'EVENTGEN 2026', category = 'VIP PASS', pattern = null } = {}) {
  const settings = await getSettings();
  const activePrinter = printerName || settings.printer_name || DEFAULT_PRINTER_NAME;
  const generator = getCommandGenerator(settings.command_language);
  const targetPattern = pattern || settings.barcode_type || 'QR_CODE';

  const payload = generator.generateSingleBarcode(barcodeValue, eventName, category, {
    pattern: targetPattern,
    widthMm: settings.stock_width_mm || 38,
    heightMm: settings.stock_height_mm || 50,
    gapMm: settings.gap_mm,
    speed: settings.speed,
    density: settings.density,
    direction: settings.direction
  });

  console.log(`\n======================================================`);
  console.log(`[RAW ${settings.command_language} STREAM - SINGLE TEST] Sending to '${activePrinter}':`);
  console.log(payload);
  console.log(`======================================================\n`);

  if (settings.gateway_mode) {
    const queueRes = await enqueueJob({
      jobType: 'test_barcode',
      printerName: activePrinter,
      commandLanguage: settings.command_language,
      rawPayload: payload,
      totalLabels: 1
    });

    return {
      success: true,
      gatewayMode: true,
      message: `Physical test label (${targetPattern}) queued for Local Gateway on '${activePrinter}' (Job #${queueRes.jobId}).`,
      printerName: activePrinter,
      barcodeType: targetPattern,
      barcodeValue,
      labelSize: `${settings.stock_width_mm || 38}mm x ${settings.stock_height_mm || 50}mm`,
      tsplSent: payload
    };
  }

  const printResult = await printRawTspl(activePrinter, payload, 'TSC_Single_Barcode_Test');
  return {
    success: true,
    message: `Physical test label (${targetPattern}) spooled to Windows printer '${activePrinter}'`,
    printerName: activePrinter,
    barcodeType: targetPattern,
    barcodeValue,
    labelSize: `${settings.stock_width_mm || 38}mm x ${settings.stock_height_mm || 50}mm`,
    bytesSent: printResult.bytesSent,
    tsplSent: payload,
    diagnostics: printResult.diagnostics
  };
}

/**
 * Print Dummy / Sample Test Label
 */
async function printTestLabel(printerName = null, { pattern = null } = {}) {
  const settings = await getSettings();
  const activePrinter = printerName || settings.printer_name || DEFAULT_PRINTER_NAME;
  const generator = getCommandGenerator(settings.command_language);

  const dummyPayload = generator.generateSingleBarcode('TEST244', 'TSC TEST', '38MM SAMPLE', {
    pattern: pattern || settings.barcode_type || 'QR_CODE',
    widthMm: settings.stock_width_mm || 38,
    heightMm: settings.stock_height_mm || 50,
    gapMm: settings.gap_mm,
    speed: settings.speed,
    density: settings.density
  });

  if (settings.gateway_mode) {
    const queueRes = await enqueueJob({
      jobType: 'test_dummy',
      printerName: activePrinter,
      commandLanguage: settings.command_language,
      rawPayload: dummyPayload,
      totalLabels: 1
    });

    return {
      success: true,
      gatewayMode: true,
      message: `Test label queued for Local Gateway on '${activePrinter}' (Job #${queueRes.jobId}).`,
      printerName: activePrinter,
      tsplSent: dummyPayload
    };
  }

  const printResult = await printRawTspl(activePrinter, dummyPayload, 'EventGen_Printer_Test');
  return {
    success: true,
    message: printResult.message || `Sample test label successfully spooled to Windows printer '${activePrinter}'`,
    printerName: activePrinter,
    bytesSent: printResult.bytesSent,
    tsplSent: dummyPayload,
    diagnostics: printResult.diagnostics
  };
}

/**
 * Send Media Gap Calibration Command
 */
async function sendCalibration(printerName = null) {
  const settings = await getSettings();
  const activePrinter = printerName || settings.printer_name || DEFAULT_PRINTER_NAME;
  const generator = getCommandGenerator(settings.command_language);

  const calPayload = generator.generateCalibration({ gapMm: settings.gap_mm });

  if (settings.gateway_mode) {
    await enqueueJob({
      jobType: 'calibrate',
      printerName: activePrinter,
      commandLanguage: settings.command_language,
      rawPayload: calPayload,
      totalLabels: 1
    });

    return {
      success: true,
      gatewayMode: true,
      message: `Media Gap Calibration command queued for Local Gateway on '${activePrinter}'.`,
      tsplSent: calPayload
    };
  }

  const result = await printRawTspl(activePrinter, calPayload, 'EventGen_Media_Gap_Calibration');
  return {
    success: true,
    message: `Media Gap Calibration (GAP-DETECT) command sent to '${activePrinter}'. Printer should calibrate and feed 1 label.`,
    tsplSent: calPayload,
    diagnostics: result.diagnostics
  };
}

/**
 * Send Unpause / Resume Command
 */
async function sendUnpause(printerName = null) {
  const settings = await getSettings();
  const activePrinter = printerName || settings.printer_name || DEFAULT_PRINTER_NAME;
  const generator = getCommandGenerator(settings.command_language);

  const unpausePayload = generator.generateUnpause();

  if (settings.gateway_mode) {
    await enqueueJob({
      jobType: 'unpause',
      printerName: activePrinter,
      commandLanguage: settings.command_language,
      rawPayload: unpausePayload,
      totalLabels: 1
    });

    return {
      success: true,
      gatewayMode: true,
      message: `Unpause command queued for Local Gateway on '${activePrinter}'.`,
      tsplSent: unpausePayload
    };
  }

  const result = await printRawTspl(activePrinter, unpausePayload, 'EventGen_Unpause_Printer');
  return {
    success: true,
    message: `Unpause command (SET PAUSE OFF) sent to '${activePrinter}'.`,
    tsplSent: unpausePayload,
    diagnostics: result.diagnostics
  };
}

/**
 * Get Comprehensive Printer Diagnostics
 */
async function getPrinterDiagnostics(printerName = null) {
  const settings = await getSettings();
  const activePrinter = printerName || settings.printer_name || DEFAULT_PRINTER_NAME;
  return await getDetailedPrinterDiagnostics(activePrinter);
}

async function pauseBatch(batchId, { userId, userName, ipAddress, userAgent } = {}) {
  await query('UPDATE print_batches SET status = "paused", updated_at = NOW() WHERE id = ?', [batchId]);
  await logAudit({
    userId,
    userName,
    action: 'PAUSE_PRINT_BATCH',
    entity: 'PRINT_BATCH',
    entityId: batchId,
    ipAddress,
    userAgent
  });
  return { success: true, status: 'paused' };
}

async function resumeBatch(batchId, { userId, userName, ipAddress, userAgent } = {}) {
  await query('UPDATE print_batches SET status = "printing", updated_at = NOW() WHERE id = ?', [batchId]);
  await logAudit({
    userId,
    userName,
    action: 'RESUME_PRINT_BATCH',
    entity: 'PRINT_BATCH',
    entityId: batchId,
    ipAddress,
    userAgent
  });
  return { success: true, status: 'printing' };
}

async function cancelBatch(batchId, { userId, userName, ipAddress, userAgent } = {}) {
  await withTransaction(async (conn) => {
    await conn.query('UPDATE passes SET print_batch_id = NULL WHERE print_batch_id = ? AND printed = 0', [batchId]);
    await conn.query('UPDATE print_batches SET status = "cancelled", updated_at = NOW() WHERE id = ?', [batchId]);
  });

  await logAudit({
    userId,
    userName,
    action: 'CANCEL_PRINT_BATCH',
    entity: 'PRINT_BATCH',
    entityId: batchId,
    ipAddress,
    userAgent
  });

  return { success: true, status: 'cancelled' };
}

async function getBatchTsplFile(batchId) {
  const settings = await getSettings();
  const generator = getCommandGenerator(settings.command_language);

  const batchRows = await query('SELECT * FROM print_batches WHERE id = ?', [batchId]);
  const batch = batchRows && batchRows.length > 0 ? batchRows[0] : {};

  const passes = await query(
    `SELECT p.code, p.code_type, p.valid_from, p.valid_until,
            c.name as category_name, e.event_name
     FROM passes p
     LEFT JOIN pass_categories c ON p.category_id = c.id
     LEFT JOIN events e ON p.event_id = e.id
     WHERE p.print_batch_id = ?
     ORDER BY p.id ASC`,
    [batchId]
  );

  const formattedPasses = passes.map(p => ({
    code: p.code,
    category_name: p.category_name,
    event_name: p.event_name,
    valid_date_label: new Date(p.valid_from).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
  }));

  return generator.generateBatch(formattedPasses, {
    pattern: batch.barcode_pattern || settings.barcode_type || 'QR_CODE',
    widthMm: settings.stock_width_mm || 38,
    heightMm: settings.stock_height_mm || 50,
    gapMm: settings.gap_mm,
    speed: settings.speed,
    density: settings.density,
    dualColumn: Boolean(settings.dual_column)
  });
}

module.exports = {
  getPrintBatches,
  createPrintBatch,
  getBatchDetails,
  processBatchChunk,
  reprintBatch,
  printTestLabel,
  printSingleBarcodeTest,
  sendCalibration,
  sendUnpause,
  getPrinterDiagnostics,
  pauseBatch,
  resumeBatch,
  cancelBatch,
  getBatchTsplFile,
  listPrinters: getAllAvailablePrinters,
  getPrinterStatus
};
