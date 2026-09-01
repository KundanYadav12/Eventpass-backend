const passService = require('../services/PassService');

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

    // RBAC check: If Admin, verify event ownership
    if (req.user?.role === 'ADMIN' && req.user.eventId && result.pass.event_id !== req.user.eventId) {
      return res.status(403).json({ success: false, message: 'Forbidden: Pass belongs to another event.' });
    }

    res.json({
      success: true,
      data: result
    });
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
  generatePasses,
  renewPass,
  bulkRenewPasses,
  voidPass,
  reissuePass
};
