const { query } = require('../config/db');

// Default fallback messages
const DEFAULT_MESSAGES = {
  ENTRY_APPROVED: 'Entry Approved',
  PASS_ALREADY_USED: 'Pass Already Used',
  PASS_ALREADY_USED_TODAY: 'Pass Already Used Today. Unlocks tomorrow at 1:00 AM.',
  PASS_EXPIRED: 'This pass has expired. Entry denied.',
  WRONG_DATE: 'This pass is not valid for today. Please check pass date.',
  PASS_VOIDED: 'This pass is voided and invalid. Entry denied.',
  INVALID_CODE: 'Invalid pass code or untrusted barcode.',
  SYSTEM_ERROR: 'System error during pass verification.'
};

// In-memory cache for ultra-fast zero-latency scanner lookups
let messageCache = { ...DEFAULT_MESSAGES };
let isCacheLoaded = false;

async function loadMessages() {
  try {
    const rows = await query('SELECT message_key, message_text FROM messages_config');
    const map = {};
    for (const row of rows) {
      map[row.message_key] = row.message_text;
    }
    messageCache = { ...DEFAULT_MESSAGES, ...map };
    isCacheLoaded = true;
    return messageCache;
  } catch (error) {
    messageCache = { ...DEFAULT_MESSAGES };
    return messageCache;
  }
}

function getMessage(key, fallback = null) {
  // Synchronous, non-blocking in-memory cache lookup for high-volume scanning
  return messageCache[key] || fallback || DEFAULT_MESSAGES[key] || key;
}

async function updateMessage(messageKey, messageText) {
  await query(
    `INSERT INTO messages_config (message_key, message_text, updated_at)
     VALUES (?, ?, NOW())
     ON DUPLICATE KEY UPDATE message_text = VALUES(message_text), updated_at = NOW()`,
    [messageKey, messageText]
  );
  messageCache[messageKey] = messageText;
  return { messageKey, messageText };
}

async function getAllMessages() {
  const rows = await query('SELECT id, message_key, message_text, description, updated_at FROM messages_config ORDER BY id ASC');
  if (rows.length === 0) {
    for (const [key, text] of Object.entries(DEFAULT_MESSAGES)) {
      await query(
        `INSERT IGNORE INTO messages_config (message_key, message_text, description) VALUES (?, ?, ?)`,
        [key, text, `System message for ${key}`]
      );
    }
    return query('SELECT id, message_key, message_text, description, updated_at FROM messages_config ORDER BY id ASC');
  }
  return rows;
}

// Pre-warm cache on initial import
loadMessages().catch(() => {});

module.exports = {
  getMessage,
  loadMessages,
  updateMessage,
  getAllMessages,
  DEFAULT_MESSAGES
};
