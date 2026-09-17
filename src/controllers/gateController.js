const gateService = require('../services/GateService');

async function getGates(req, res, next) {
  try {
    const eventId = req.effectiveEventId || req.params.eventId || req.query.eventId;
    if (!eventId) {
      return res.status(400).json({ success: false, message: 'Event ID is required' });
    }

    const includeInactive = req.query.includeInactive === 'true' || req.query.all === 'true';
    const gates = await gateService.getGates(eventId, includeInactive);
    res.json({
      success: true,
      data: gates,
      gates
    });
  } catch (error) {
    next(error);
  }
}

async function createGate(req, res, next) {
  try {
    const eventId = req.effectiveEventId || req.params.eventId || req.body.eventId || req.body.event_id;
    const gateName = req.body.gateName || req.body.gate_name || req.body.name;
    const gateCode = req.body.gateCode || req.body.gate_code || req.body.code;
    const description = req.body.description;
    const displayOrder = req.body.displayOrder !== undefined ? req.body.displayOrder : (req.body.display_order !== undefined ? req.body.display_order : 0);
    const userId = req.user?.id || null;
    const userName = req.user?.name || 'Admin';
    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'];

    const result = await gateService.createGate({
      eventId,
      gateName,
      gateCode,
      description,
      displayOrder,
      userId,
      userName,
      ipAddress,
      userAgent
    });

    res.json({
      success: true,
      message: 'Gate created successfully',
      ...result
    });
  } catch (error) {
    next(error);
  }
}

async function updateGate(req, res, next) {
  try {
    const { id } = req.params;
    const { gateName, gateCode, description, displayOrder, isActive } = req.body;
    const userId = req.user?.id || null;
    const userName = req.user?.name || 'Admin';
    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'];

    const result = await gateService.updateGate({
      id,
      gateName: gateName || req.body.gate_name || req.body.name,
      gateCode: gateCode || req.body.gate_code || req.body.code,
      description,
      displayOrder: displayOrder !== undefined ? displayOrder : req.body.display_order,
      isActive: isActive !== undefined ? isActive : req.body.is_active,
      userId,
      userName,
      ipAddress,
      userAgent
    });

    res.json({
      success: true,
      message: 'Gate updated successfully',
      ...result
    });
  } catch (error) {
    next(error);
  }
}

async function deleteGate(req, res, next) {
  try {
    const { id } = req.params;
    const userId = req.user?.id || null;
    const userName = req.user?.name || 'Admin';
    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'];

    const result = await gateService.deleteGate({
      id,
      userId,
      userName,
      ipAddress,
      userAgent
    });

    res.json({
      success: true,
      message: 'Gate deleted successfully',
      ...result
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getGates,
  createGate,
  updateGate,
  deleteGate
};
