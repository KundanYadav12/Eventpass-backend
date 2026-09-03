const eventDeliveryService = require('../services/eventDeliveryService');
const { query } = require('../config/db');

async function getEmailSettings(req, res, next) {
  try {
    const eventId = req.params.eventId || req.effectiveEventId;
    if (!eventId) {
      return res.status(400).json({ success: false, message: 'Event ID is required' });
    }

    const settings = await eventDeliveryService.getEventEmailSettings(parseInt(eventId, 10), { internal: false });
    res.json({ success: true, settings });
  } catch (err) {
    next(err);
  }
}

async function updateEmailSettings(req, res, next) {
  try {
    const eventId = req.params.eventId || req.effectiveEventId;
    if (!eventId) {
      return res.status(400).json({ success: false, message: 'Event ID is required' });
    }

    const updated = await eventDeliveryService.saveEventEmailSettings(parseInt(eventId, 10), req.body);
    res.json({ success: true, message: 'Event email configuration updated successfully', settings: updated });
  } catch (err) {
    next(err);
  }
}

async function testEmail(req, res, next) {
  try {
    const eventId = req.params.eventId || req.effectiveEventId;
    const { recipientEmail, settings } = req.body;

    if (!eventId || !recipientEmail) {
      return res.status(400).json({ success: false, message: 'Event ID and recipientEmail are required' });
    }

    const result = await eventDeliveryService.testEventEmail({
      eventId: parseInt(eventId, 10),
      recipientEmail: recipientEmail.trim(),
      overrideSettings: settings || null
    });

    if (result.success) {
      res.json({
        success: true,
        message: result.simulated
          ? `[Simulation Mode] Test email verified for ${recipientEmail} with sample Pass & Bill PDFs.`
          : `✅ Test email successfully delivered to ${recipientEmail} with Pass & Bill PDFs! (Message ID: ${result.messageId})`,
        details: result
      });
    } else {
      res.status(400).json({
        success: false,
        message: `❌ Failed to send test email: ${result.error || result.message}`,
        details: result
      });
    }
  } catch (err) {
    res.status(400).json({
      success: false,
      message: `❌ Failed to send test email: ${err.message}`
    });
  }
}

async function getWhatsappSettings(req, res, next) {
  try {
    const eventId = req.params.eventId || req.effectiveEventId;
    if (!eventId) {
      return res.status(400).json({ success: false, message: 'Event ID is required' });
    }

    const settings = await eventDeliveryService.getEventWhatsappSettings(parseInt(eventId, 10), { internal: false });
    res.json({ success: true, settings });
  } catch (err) {
    next(err);
  }
}

async function updateWhatsappSettings(req, res, next) {
  try {
    const eventId = req.params.eventId || req.effectiveEventId;
    if (!eventId) {
      return res.status(400).json({ success: false, message: 'Event ID is required' });
    }

    const updated = await eventDeliveryService.saveEventWhatsappSettings(parseInt(eventId, 10), req.body);
    res.json({ success: true, message: 'Event WhatsApp configuration updated successfully', settings: updated });
  } catch (err) {
    next(err);
  }
}

async function getDeliveryLogs(req, res, next) {
  try {
    const eventId = req.params.eventId || req.effectiveEventId;
    const logs = await query(
      `SELECT * FROM delivery_logs
       WHERE event_id = ?
       ORDER BY id DESC LIMIT 50`,
      [parseInt(eventId, 10)]
    );

    res.json({ success: true, logs: logs || [] });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getEmailSettings,
  updateEmailSettings,
  testEmail,
  getWhatsappSettings,
  updateWhatsappSettings,
  getDeliveryLogs
};
