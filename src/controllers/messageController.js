const messageService = require('../services/MessageService');
const { logAudit } = require('../services/AuditService');

async function getMessages(req, res, next) {
  try {
    const messages = await messageService.getAllMessages();
    res.json({
      success: true,
      data: messages
    });
  } catch (error) {
    next(error);
  }
}

async function updateMessage(req, res, next) {
  try {
    const { key } = req.params;
    const { text } = req.body;
    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'];

    if (!text) {
      return res.status(400).json({ success: false, message: 'Message text is required' });
    }

    const oldText = await messageService.getMessage(key);
    await messageService.updateMessage(key, text);

    await logAudit({
      userId: req.user?.id,
      userName: req.user?.name,
      action: 'UPDATE_MESSAGE_CONFIG',
      entity: 'MESSAGE',
      entityId: key,
      oldValue: { text: oldText },
      newValue: { text },
      ipAddress,
      userAgent
    });

    res.json({
      success: true,
      message: 'Scanner message updated successfully'
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getMessages,
  updateMessage
};
