/**
 * Generic Text / RAW Command Generator for Generic Printers
 */

function sanitizeAscii(str) {
  if (!str) return '';
  return String(str).replace(/[^\x20-\x7E\r\n]/g, '');
}

function generateSinglePass(pass, options = {}) {
  const code = sanitizeAscii(pass.code || 'PASS001');

  return `
========================================
  [ BARCODE / QR CODE ]
  PASS CODE: ${code}
========================================
\x0C`;
}

function generateBatch(passes = [], options = {}) {
  return passes.map(p => generateSinglePass(p, options)).join('\r\n');
}

function generateSingleBarcode(barcodeValue = '55KDBD2', eventName = '', category = '', options = {}) {
  return `
========================================
  [ BARCODE / QR CODE ]
  PASS CODE: ${barcodeValue}
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
