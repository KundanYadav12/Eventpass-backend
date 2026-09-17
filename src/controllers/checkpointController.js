const checkpointService = require('../services/CheckpointService');

async function getCheckpoints(req, res, next) {
  try {
    const eventId = req.effectiveEventId || req.params.eventId || req.query.eventId;
    if (!eventId) {
      return res.status(400).json({ success: false, message: 'Event ID is required' });
    }

    const checkpoints = await checkpointService.getCheckpoints(eventId);
    res.json({
      success: true,
      data: checkpoints,
      checkpoints
    });
  } catch (error) {
    next(error);
  }
}

async function createCheckpoint(req, res, next) {
  try {
    const eventId = req.effectiveEventId || req.params.eventId || req.body.eventId || req.body.event_id;
    const name = req.body.name || req.body.checkpoint_name;
    const code = req.body.code || req.body.checkpoint_code;
    const description = req.body.description || req.body.checkpoint_description;
    const displayOrder = req.body.displayOrder !== undefined ? req.body.displayOrder : (req.body.display_order !== undefined ? req.body.display_order : 0);
    const maxScansPerPass = req.body.maxScansPerPass !== undefined ? req.body.maxScansPerPass : (req.body.max_scans_per_pass !== undefined ? req.body.max_scans_per_pass : 1);
    const allowedCategories = req.body.allowedCategories || req.body.allowed_categories;
    const userId = req.user?.id || null;
    const userName = req.user?.name || 'Admin';
    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'];

    const result = await checkpointService.createCheckpoint({
      eventId,
      name,
      code,
      description,
      displayOrder,
      maxScansPerPass,
      allowedCategories,
      userId,
      userName,
      ipAddress,
      userAgent
    });

    res.json({
      success: true,
      message: 'Checkpoint created successfully',
      ...result
    });
  } catch (error) {
    next(error);
  }
}

async function updateCheckpoint(req, res, next) {
  try {
    const { id } = req.params;
    const { name, code, description, displayOrder, isActive, maxScansPerPass, allowedCategories } = req.body;
    const userId = req.user?.id || null;
    const userName = req.user?.name || 'Admin';
    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'];

    const result = await checkpointService.updateCheckpoint({
      id,
      name,
      code,
      description,
      displayOrder,
      isActive,
      maxScansPerPass,
      allowedCategories,
      userId,
      userName,
      ipAddress,
      userAgent
    });

    res.json({
      success: true,
      message: 'Checkpoint updated successfully',
      ...result
    });
  } catch (error) {
    next(error);
  }
}

async function deleteCheckpoint(req, res, next) {
  try {
    const { id } = req.params;
    const userId = req.user?.id || null;
    const userName = req.user?.name || 'Admin';
    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'];

    const result = await checkpointService.deleteCheckpoint({
      id,
      userId,
      userName,
      ipAddress,
      userAgent
    });

    res.json({
      success: true,
      message: 'Checkpoint deleted / deactivated successfully',
      ...result
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getCheckpoints,
  createCheckpoint,
  updateCheckpoint,
  deleteCheckpoint
};
