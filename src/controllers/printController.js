const printService = require('../services/PrintService');
const printerConfigService = require('../services/PrinterConfigService');
const printGatewayService = require('../services/PrintGatewayService');

async function getBatches(req, res, next) {
  try {
    const eventId = req.effectiveEventId || req.query.eventId;
    const result = await printService.getPrintBatches({
      ...req.query,
      eventId
    });
    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    next(error);
  }
}

async function createBatch(req, res, next) {
  try {
    const { eventId, categoryId, name, quantity } = req.body;
    const targetEventId = req.effectiveEventId || eventId;
    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'];

    if (!targetEventId || !categoryId || !quantity) {
      return res.status(400).json({ success: false, message: 'Event ID, Category ID, and quantity are required' });
    }

    const result = await printService.createPrintBatch({
      eventId: targetEventId,
      categoryId,
      name,
      quantity,
      userId: req.user?.id,
      userName: req.user?.name,
      ipAddress,
      userAgent
    });

    res.status(201).json({
      success: true,
      message: 'Print batch created successfully',
      data: result
    });
  } catch (error) {
    next(error);
  }
}

async function getBatchById(req, res, next) {
  try {
    const { id } = req.params;
    const result = await printService.getBatchDetails(id);
    if (!result) {
      return res.status(404).json({ success: false, message: 'Print batch not found' });
    }
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    next(error);
  }
}

async function processChunk(req, res, next) {
  try {
    const { id } = req.params;
    const { chunkSize = 50, printerName = 'TSC TE244' } = req.body;
    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'];

    const result = await printService.processBatchChunk(id, chunkSize, printerName, {
      userId: req.user?.id,
      userName: req.user?.name,
      ipAddress,
      userAgent
    });

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    next(error);
  }
}

async function pauseBatch(req, res, next) {
  try {
    const { id } = req.params;
    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'];

    const result = await printService.pauseBatch(id, {
      userId: req.user?.id,
      userName: req.user?.name,
      ipAddress,
      userAgent
    });

    res.json({
      success: true,
      message: 'Print batch paused',
      data: result
    });
  } catch (error) {
    next(error);
  }
}

async function resumeBatch(req, res, next) {
  try {
    const { id } = req.params;
    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'];

    const result = await printService.resumeBatch(id, {
      userId: req.user?.id,
      userName: req.user?.name,
      ipAddress,
      userAgent
    });

    res.json({
      success: true,
      message: 'Print batch resumed',
      data: result
    });
  } catch (error) {
    next(error);
  }
}

async function cancelBatch(req, res, next) {
  try {
    const { id } = req.params;
    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'];

    const result = await printService.cancelBatch(id, {
      userId: req.user?.id,
      userName: req.user?.name,
      ipAddress,
      userAgent
    });

    res.json({
      success: true,
      message: 'Print batch cancelled and unprinted passes released',
      data: result
    });
  } catch (error) {
    next(error);
  }
}

async function downloadTspl(req, res, next) {
  try {
    const { id } = req.params;
    const tsplCode = await printService.getBatchTsplFile(id);
    
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename="batch_${id}_tsc_te244.tspl"`);
    res.send(tsplCode);
  } catch (error) {
    next(error);
  }
}

async function printTest(req, res, next) {
  try {
    const { printerName = 'TSC TE244' } = req.body;
    const result = await printService.printTestLabel(printerName);
    res.json(result);
  } catch (error) {
    next(error);
  }
}

async function printTestBarcode(req, res, next) {
  try {
    const { printerName = 'TSC TE244', barcodeValue = '55KDBD2' } = req.body;
    const result = await printService.printSingleBarcodeTest(printerName, barcodeValue);
    res.json(result);
  } catch (error) {
    next(error);
  }
}

async function getPrinters(req, res, next) {
  try {
    const printers = await printService.listPrinters();
    res.json({
      success: true,
      printers
    });
  } catch (error) {
    next(error);
  }
}

async function reprintBatch(req, res, next) {
  try {
    const { id } = req.params;
    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'];

    const result = await printService.reprintBatch(id, {
      userId: req.user?.id,
      userName: req.user?.name,
      ipAddress,
      userAgent
    });

    res.json({
      success: true,
      message: result.message,
      data: result
    });
  } catch (error) {
    next(error);
  }
}

async function getDiagnostics(req, res, next) {
  try {
    const { printerName = 'TSC TE244' } = req.query;
    const diagnostics = await printService.getPrinterDiagnostics(printerName);
    res.json({
      success: true,
      diagnostics
    });
  } catch (error) {
    next(error);
  }
}

async function calibrate(req, res, next) {
  try {
    const { printerName = 'TSC TE244' } = req.body;
    const result = await printService.sendCalibration(printerName);
    res.json(result);
  } catch (error) {
    next(error);
  }
}

async function unpause(req, res, next) {
  try {
    const { printerName = 'TSC TE244' } = req.body;
    const result = await printService.sendUnpause(printerName);
    res.json(result);
  } catch (error) {
    next(error);
  }
}

async function reconnect(req, res, next) {
  try {
    const { printerName = 'TSC TE244' } = req.body;
    const { reconnectPrinter } = require('../utils/printerDriver');
    const diag = await reconnectPrinter(printerName);
    res.json({
      success: true,
      message: `Hardware status refreshed for '${printerName}'`,
      diagnostics: diag
    });
  } catch (error) {
    next(error);
  }
}

async function getSettingsController(req, res, next) {
  try {
    const { eventId } = req.query;
    const settings = await printerConfigService.getSettings(eventId);
    res.json({
      success: true,
      settings
    });
  } catch (error) {
    next(error);
  }
}

async function updateSettingsController(req, res, next) {
  try {
    const { eventId } = req.query;
    const updated = await printerConfigService.updateSettings(req.body, eventId);
    res.json({
      success: true,
      message: 'Printer settings updated successfully',
      settings: updated
    });
  } catch (error) {
    next(error);
  }
}

// --- Local Windows Gateway Endpoints ---

async function gatewayHeartbeat(req, res, next) {
  try {
    const apiKey = req.headers['x-gateway-key'] || req.body.apiKey;
    const isAuth = await printGatewayService.authenticateGatewayKey(apiKey);
    if (!isAuth) {
      return res.status(401).json({ success: false, error: 'Invalid Gateway API Key' });
    }

    const { deviceId = 'venue-pc-1', printers = [] } = req.body;
    await printerConfigService.recordGatewayPrinters(deviceId, printers);

    res.json({
      success: true,
      message: 'Gateway heartbeat and printers recorded',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    next(error);
  }
}

async function gatewayPending(req, res, next) {
  try {
    const apiKey = req.headers['x-gateway-key'] || req.query.apiKey;
    const isAuth = await printGatewayService.authenticateGatewayKey(apiKey);
    if (!isAuth) {
      return res.status(401).json({ success: false, error: 'Invalid Gateway API Key' });
    }

    const { deviceId = 'venue-pc-1', limit = 5 } = req.query;
    const jobs = await printGatewayService.getPendingJobsForGateway(deviceId, parseInt(limit, 10) || 5);

    res.json({
      success: true,
      count: jobs.length,
      jobs
    });
  } catch (error) {
    next(error);
  }
}

async function gatewayJobStatus(req, res, next) {
  try {
    const apiKey = req.headers['x-gateway-key'] || req.body.apiKey;
    const isAuth = await printGatewayService.authenticateGatewayKey(apiKey);
    if (!isAuth) {
      return res.status(401).json({ success: false, error: 'Invalid Gateway API Key' });
    }

    const { id } = req.params;
    const { status, errorMessage, deviceId } = req.body;

    const result = await printGatewayService.updateJobStatus(id, {
      status,
      errorMessage,
      gatewayDeviceId: deviceId
    });

    res.json({
      success: true,
      result
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getBatches,
  createBatch,
  getBatchById,
  processChunk,
  pauseBatch,
  resumeBatch,
  cancelBatch,
  reprintBatch,
  downloadTspl,
  printTest,
  printTestBarcode,
  getPrinters,
  getDiagnostics,
  calibrate,
  unpause,
  reconnect,
  getSettings: getSettingsController,
  updateSettings: updateSettingsController,
  gatewayHeartbeat,
  gatewayPending,
  gatewayJobStatus
};
