const passService = require('../services/PassService');
const { query } = require('../config/db');

async function getPasses(req, res, next) {
  try {
    const eventId = req.effectiveEventId || req.query.eventId;
    const result = await passService.getPasses({
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

async function getPassById(req, res, next) {
  try {
    const { id } = req.params;
    const result = await passService.getPassDetails(id);
    if (!result) {
      return res.status(404).json({ success: false, message: 'Pass not found' });
    }

    // RBAC check: If Admin, verify event ownership (primary event or user_assigned_events)
    if (req.user?.role === 'ADMIN' && req.user.eventId && Number(result.pass.event_id) !== Number(req.user.eventId)) {
      const assigned = await query('SELECT id FROM user_assigned_events WHERE user_id = ? AND event_id = ? LIMIT 1', [req.user.id, result.pass.event_id]);
      if (!assigned || assigned.length === 0) {
        return res.status(403).json({ success: false, message: 'Forbidden: Pass belongs to another event.' });
      }
    }

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    next(error);
  }
}

async function resharePass(req, res, next) {
  try {
    const { id } = req.params;
    const {
      sharingMethod,
      customerEmail,
      customerPhone,
      emailSubject,
      notes
    } = req.body;

    const existing = await passService.getPassDetails(id);
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Pass not found' });
    }

    // RBAC check: If Admin, verify event ownership (primary event or user_assigned_events)
    if (req.user?.role === 'ADMIN' && req.user.eventId && Number(existing.pass.event_id) !== Number(req.user.eventId)) {
      const assigned = await query('SELECT id FROM user_assigned_events WHERE user_id = ? AND event_id = ? LIMIT 1', [req.user.id, existing.pass.event_id]);
      if (!assigned || assigned.length === 0) {
        return res.status(403).json({ success: false, message: 'Forbidden: Pass belongs to another event.' });
      }
    }

    // Calculate dynamic base URL from incoming request
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.headers['x-forwarded-host'] || req.get('host') || 'localhost:5006';
    const reqBaseUrl = process.env.PUBLIC_URL || process.env.APP_BASE_URL || `${proto}://${host}`;

    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'];

    const result = await passService.resharePass({
      passId: parseInt(id, 10),
      sharingMethod,
      customerEmail,
      customerPhone,
      emailSubject,
      notes,
      userId: req.user?.id,
      userName: req.user?.name,
      ipAddress,
      userAgent,
      baseUrl: reqBaseUrl
    });

    res.json(result);
  } catch (error) {
    next(error);
  }
}

async function exportPassesExcel(req, res, next) {
  try {
    const eventId = req.effectiveEventId || req.query.eventId || null;
    const buffer = await passService.exportPassesExcel({
      ...req.query,
      eventId
    });

    const filename = `PassInventory_${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (error) {
    next(error);
  }
}

async function generatePasses(req, res, next) {
  try {
    const { eventId, categoryId, quantity } = req.body;
    const targetEventId = req.effectiveEventId || eventId;
    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'];

    const result = await passService.generatePasses({
      eventId: targetEventId,
      categoryId,
      quantity,
      userId: req.user?.id,
      userName: req.user?.name,
      ipAddress,
      userAgent
    });

    res.status(201).json({
      success: true,
      message: `Generated ${result.generatedCount} unique 7-character passes`,
      data: result
    });
  } catch (error) {
    next(error);
  }
}

async function renewPass(req, res, next) {
  try {
    const { id } = req.params;
    const { validFrom, validUntil, resetUsage, resetStatus, reason } = req.body;
    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'];

    const result = await passService.renewPass(id, {
      validFrom,
      validUntil,
      resetUsage: Boolean(resetUsage),
      resetStatus: resetStatus !== false,
      reason,
      userId: req.user?.id,
      userName: req.user?.name,
      ipAddress,
      userAgent
    });

    res.json({
      success: true,
      message: 'Pass renewed successfully',
      data: result
    });
  } catch (error) {
    next(error);
  }
}

async function bulkRenewPasses(req, res, next) {
  try {
    const { passIds, validFrom, validUntil, resetUsage, resetStatus, reason } = req.body;
    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'];

    const result = await passService.bulkRenewPasses({
      passIds,
      validFrom,
      validUntil,
      resetUsage: Boolean(resetUsage),
      resetStatus: resetStatus !== false,
      reason,
      userId: req.user?.id,
      userName: req.user?.name,
      ipAddress,
      userAgent
    });

    res.json({
      success: true,
      message: `Successfully renewed ${result.updatedCount} passes`,
      data: result
    });
  } catch (error) {
    next(error);
  }
}

async function voidPass(req, res, next) {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'];

    const result = await passService.voidPass(id, {
      reason,
      userId: req.user?.id,
      userName: req.user?.name,
      ipAddress,
      userAgent
    });

    res.json({
      success: true,
      message: 'Pass voided successfully',
      data: result
    });
  } catch (error) {
    next(error);
  }
}

async function reissuePass(req, res, next) {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'];

    const result = await passService.reissuePass(id, {
      reason,
      userId: req.user?.id,
      userName: req.user?.name,
      ipAddress,
      userAgent
    });

    res.json({
      success: true,
      message: 'Pass reissued with new 7-character code and signature',
      data: result
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getPasses,
  getPassById,
  resharePass,
  exportPassesExcel,
  generatePasses,
  renewPass,
  bulkRenewPasses,
  voidPass,
  reissuePass
};
