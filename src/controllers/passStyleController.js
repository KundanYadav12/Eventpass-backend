const passStyleService = require('../services/PassStyleService');

async function getStyles(req, res, next) {
  try {
    const isSuperAdmin = req.user?.role === 'SUPERADMIN';
    const eventId = req.effectiveEventId || req.query.eventId || null;

    const styles = await passStyleService.getStyles({ eventId, isSuperAdmin });
    res.json({
      success: true,
      data: styles
    });
  } catch (error) {
    next(error);
  }
}

async function getStyleById(req, res, next) {
  try {
    const { id } = req.params;
    const style = await passStyleService.getStyleById(id);

    if (!style) {
      return res.status(404).json({ success: false, message: 'Pass style not found' });
    }

    res.json({
      success: true,
      data: style
    });
  } catch (error) {
    next(error);
  }
}

async function createStyle(req, res, next) {
  try {
    const isSuperAdmin = req.user?.role === 'SUPERADMIN';
    const {
      eventId = null,
      name,
      description,
      backgroundImageUrl,
      canvasWidth,
      canvasHeight,
      elementsConfig,
      isDefault
    } = req.body;

    const assignedEventId = isSuperAdmin ? (eventId || req.effectiveEventId) : req.effectiveEventId;

    const style = await passStyleService.createStyle({
      eventId: assignedEventId,
      name,
      description,
      backgroundImageUrl,
      canvasWidth,
      canvasHeight,
      elementsConfig,
      isDefault,
      userId: req.user?.id,
      userName: req.user?.name,
      ipAddress: req.ip || req.connection.remoteAddress,
      userAgent: req.headers['user-agent']
    });

    res.status(201).json({
      success: true,
      message: 'Pass style saved successfully',
      data: style
    });
  } catch (error) {
    next(error);
  }
}

async function updateStyle(req, res, next) {
  try {
    const { id } = req.params;
    const isSuperAdmin = req.user?.role === 'SUPERADMIN';
    const {
      name,
      description,
      backgroundImageUrl,
      canvasWidth,
      canvasHeight,
      elementsConfig,
      isDefault
    } = req.body;

    const style = await passStyleService.updateStyle(id, {
      name,
      description,
      backgroundImageUrl,
      canvasWidth,
      canvasHeight,
      elementsConfig,
      isDefault,
      eventId: req.effectiveEventId,
      isSuperAdmin,
      userId: req.user?.id,
      userName: req.user?.name,
      ipAddress: req.ip || req.connection.remoteAddress,
      userAgent: req.headers['user-agent']
    });

    res.json({
      success: true,
      message: 'Pass style updated successfully',
      data: style
    });
  } catch (error) {
    next(error);
  }
}

async function deleteStyle(req, res, next) {
  try {
    const { id } = req.params;
    const isSuperAdmin = req.user?.role === 'SUPERADMIN';

    const result = await passStyleService.deleteStyle(id, {
      eventId: req.effectiveEventId,
      isSuperAdmin,
      userId: req.user?.id,
      userName: req.user?.name,
      ipAddress: req.ip || req.connection.remoteAddress
    });

    res.json(result);
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getStyles,
  getStyleById,
  createStyle,
  updateStyle,
  deleteStyle
};
