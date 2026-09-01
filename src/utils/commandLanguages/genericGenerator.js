/**
 * Generic Text / RAW Command Generator for Generic Printers
 */

function sanitizeAscii(str) {
  if (!str) return '';
  return String(str).replace(/[^\x20-\x7E\r\n]/g, '');
}

function generateSinglePass(pass, options = {}) {
  const code = sanitizeAscii(pass.code || 'PASS001');
  const eventName = sanitizeAscii(pass.event_name || 'EVENTGEN 2026');
  const categoryName = sanitizeAscii(pass.category_name || 'GENERAL');
  const dateLabel = sanitizeAscii(pass.valid_date_label || 'VALID 2026');

  return `
========================================
  ${eventName.toUpperCase()}
  ${categoryName}
----------------------------------------
  PASS CODE: ${code}
  VALIDITY : ${dateLabel}
----------------------------------------
  DO NOT DUPLICATE - GATE SCANNABLE
========================================
\x0C`;
}

function generateBatch(passes = [], options = {}) {
  return passes.map(p => generateSinglePass(p, options)).join('\r\n');
}

function generateSingleBarcode(barcodeValue = '55KDBD2', eventName = 'EVENTGEN 2026', category = 'VIP PASS', options = {}) {
  return `
========================================
  ${eventName.toUpperCase()}
  ${category}
----------------------------------------
  PASS CODE: ${barcodeValue}
  TEST PRINT - MACHINE SCANNABLE
========================================
\x0C`;
}

function generateCalibration(options = {}) {
  return '\x0C'; // Form Feed
}

function generateUnpause() {
  return '\r\n';
}

module.exports = {
  language: 'GENERIC_TEXT',
  generateSinglePass,
  generateBatch,
  generateSingleBarcode,
  generateCalibration,
  generateUnpause,
  sanitizeAscii
};
