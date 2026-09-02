/**
 * Zebra ZPL II Command Language Generator for Zebra and compatible thermal printers
 * 
 * Supports:
 * - 38mm x 50mm label stock (304 x 400 dots at 203 DPI)
 * - Code 128 (^BC), Code 39 (^B3), and 2D QR Codes (^BQ)
 * - Standard ZPL II syntax (^XA ... ^XZ)
 */

function sanitizeAscii(str) {
  if (!str) return '';
  return String(str)
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[^\x20-\x7E]/g, '')
    .trim();
}

/**
 * Generate ZPL for a Single 38mm x 50mm Pass
 */
function generateSinglePass(pass, options = {}) {
  const code = sanitizeAscii(pass.code || 'PASS001').toUpperCase();
  const qrData = sanitizeAscii(pass.qr_data || pass.signed_code || code);
  const pattern = String(options.pattern || pass.barcode_pattern || 'QR_CODE').toUpperCase();

  const lines = [
    '^XA',
    '^PW304',
    '^LL400',
    '^FO8,8^GB286,382,2^FS'
  ];

  if (pattern === 'CODE128' || pattern === '128') {
    lines.push(`^FO16,100^BCN,130,N,N,N^FD${code}^FS`);
    lines.push(`^FO16,260^A0N,28,28^FDPASS CODE: ${code}^FS`);
  } else if (pattern === 'CODE39' || pattern === '39') {
    lines.push(`^FO16,100^B3N,N,130,N,N^FD${code}^FS`);
    lines.push(`^FO16,260^A0N,28,28^FDPASS CODE: ${code}^FS`);
  } else {
    // QR Code
    lines.push(`^FO55,60^BQN,2,6^FDLA,${qrData}^FS`);
    lines.push(`^FO16,270^A0N,28,28^FDPASS CODE: ${code}^FS`);
  }

  lines.push('^XZ');

  return lines.join('\r\n') + '\r\n';
}

/**
 * Generate ZPL for Batch
 */
function generateBatch(passes = [], options = {}) {
  return passes.map(p => generateSinglePass(p, options)).join('');
}

/**
 * Generate Single Barcode Test in ZPL
 */
function generateSingleBarcode(barcodeValue = '55KDBD2', eventName = 'EVENTGEN 2026', category = 'VIP PASS', options = {}) {
  const dummyPass = {
    code: barcodeValue,
    event_name: eventName,
    category_name: category,
    valid_date_label: 'VALID: 2026',
    qr_data: barcodeValue,
    barcode_pattern: options.pattern || 'QR_CODE'
  };

  return generateSinglePass(dummyPass, options);
}

/**
 * Generate Calibration Command (ZPL ~JC Form Feed / Calibrate)
 */
function generateCalibration(options = {}) {
  return '~JC\r\n^XA^JUS^XZ\r\n';
}

/**
 * Generate Unpause Command (ZPL ~PS / ~PP)
 */
function generateUnpause() {
  return '~PS\r\n';
}

module.exports = {
  language: 'ZPL',
  generateSinglePass,
  generateBatch,
  generateSingleBarcode,
  generateCalibration,
  generateUnpause,
  sanitizeAscii
};
