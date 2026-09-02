const eventService = require('../services/EventService');

async function getEvents(req, res, next) {
  try {
    const events = await eventService.getEvents(req.query);
    res.json({
      success: true,
      data: events
    });
  } catch (error) {
    next(error);
  }
}

async function getEventById(req, res, next) {
  try {
    const { id } = req.params;
    const event = await eventService.getEventById(id);
    if (!event) {
      return res.status(404).json({ success: false, message: 'Event not found' });
    }
    res.json({
      success: true,
      data: event
    });
  } catch (error) {
    next(error);
  }
}

async function createEvent(req, res, next) {
  try {
    const { eventName, eventCode, description, venue, startDate, endDate, status, barcodeType, stickerWidthMm, stickerHeightMm } = req.body;
    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'];

    const newEvent = await eventService.createEvent({
      eventName,
      eventCode,
      description,
      venue,
      startDate,
      endDate,
      status,
      barcodeType,
      stickerWidthMm,
      stickerHeightMm,
      userId: req.user?.id,
      userName: req.user?.name,
      ipAddress,
      userAgent
    });

    res.status(201).json({
      success: true,
      message: 'Event created successfully',
      data: newEvent
    });
  } catch (error) {
    next(error);
  }
}

async function updateEvent(req, res, next) {
  try {
    const { id } = req.params;
    const { eventName, eventCode, description, venue, startDate, endDate, status, barcodeType, stickerWidthMm, stickerHeightMm } = req.body;
    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'];

    const updated = await eventService.updateEvent(id, {
      eventName,
      eventCode,
      description,
      venue,
      startDate,
      endDate,
      status,
      barcodeType,
      stickerWidthMm,
      stickerHeightMm,
      userId: req.user?.id,
      userName: req.user?.name,
      ipAddress,
      userAgent
    });

    res.json({
      success: true,
      message: 'Event updated successfully',
      data: updated
    });
  } catch (error) {
    next(error);
  }
}

async function toggleEventStatus(req, res, next) {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'];

    const result = await eventService.toggleEventStatus(id, status, {
      userId: req.user?.id,
      userName: req.user?.name,
      ipAddress,
      userAgent
    });

    res.json({
      success: true,
      message: `Event status changed to ${status}`,
      data: result
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getEvents,
  getEventById,
  createEvent,
  updateEvent,
  toggleEventStatus
};
