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

function validateBackgroundImageSize(backgroundImageUrl) {
  if (!backgroundImageUrl || typeof backgroundImageUrl !== 'string') return;
  if (backgroundImageUrl.startsWith('data:image/')) {
    const commaIdx = backgroundImageUrl.indexOf(',');
    const base64Data = commaIdx !== -1 ? backgroundImageUrl.slice(commaIdx + 1) : backgroundImageUrl;
    const padding = (base64Data.endsWith('==') ? 2 : base64Data.endsWith('=') ? 1 : 0);
    const byteLength = Math.round((base64Data.length * 3) / 4 - padding);
    // Hard ceiling: 500 KB (512,000 bytes) + 3KB buffer
    if (byteLength > 515 * 1024) {
      const err = new Error(`Background image size (${Math.round(byteLength / 1024)} KB) exceeds the maximum allowed limit of 500 KB.`);
      err.statusCode = 400;
      throw err;
    }
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

    validateBackgroundImageSize(backgroundImageUrl);

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

    validateBackgroundImageSize(backgroundImageUrl);

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
