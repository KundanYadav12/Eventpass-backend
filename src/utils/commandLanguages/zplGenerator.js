/**
 * Zebra ZPL II Command Language Generator for Zebra and compatible thermal printers
 * 
 * Supports:
 * - 50mm x 50mm label stock (400 x 400 dots at 203 DPI)
 * - Code 128 Barcodes (^BC) & 2D QR Codes (^BQ)
 * - Standard ZPL II syntax (^XA ... ^XZ)
 */

function sanitizeAscii(str) {
  if (!str) return '';
  return String(str)
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[^\x20-\x7E]/g, '');
}

/**
 * Generate ZPL for a Single 50mm x 50mm Pass
 */
function generateSinglePass(pass, options = {}) {
  const code = sanitizeAscii(pass.code || 'PASS001');
  const eventName = sanitizeAscii(pass.event_name || 'EVENTGEN 2026').substring(0, 20);
  const categoryName = sanitizeAscii(pass.category_name || 'VIP').substring(0, 16);
  const dateLabel = sanitizeAscii(pass.valid_date_label || 'VALID 2026').substring(0, 16);
  const qrData = sanitizeAscii(pass.qr_data || pass.signed_code || code);

  const lines = [
    '^XA',
    '^PW400',
    '^LL400',
    '^FO20,20^GB360,360,2^FS',
    `^FO30,30^A0N,28,28^FD${eventName}^FS`,
    `^FO30,65^A0N,32,32^FD${categoryName}^FS`,
    `^FO30,110^BQN,2,5^FDLA,${qrData}^FS`,
    '^FO180,130^A0N,22,22^FDPASS CODE:^FS',
    `^FO180,160^A0N,36,36^FD${code}^FS`,
    `^FO30,310^A0N,22,22^FD${dateLabel}^FS`,
    '^FO30,345^A0N,18,18^FDDO NOT DUPLICATE - SCANNABLE^FS',
    '^XZ'
  ];

  return lines.join('\r\n') + '\r\n';
}

/**
 * Generate ZPL for Batch
 */
function generateBatch(passes = [], options = {}) {
  return passes.map(p => generateSinglePass(p, options)).join('');
}

/**
 * Generate Single Code 128 Barcode Test in ZPL
 */
function generateSingleBarcode(barcodeValue = '55KDBD2', eventName = 'EVENTGEN 2026', category = 'VIP PASS', options = {}) {
  const val = sanitizeAscii(barcodeValue);
  const ev = sanitizeAscii(eventName).substring(0, 20);
  const cat = sanitizeAscii(category).substring(0, 16);

  const lines = [
    '^XA',
    '^PW400',
    '^LL400',
    '^FO20,20^GB360,360,2^FS',
    `^FO35,35^A0N,30,30^FD${ev}^FS`,
    `^FO35,70^A0N,26,26^FD${cat}^FS`,
    `^FO35,110^BCN,90,Y,N,N^FD${val}^FS`,
    `^FO35,230^A0N,24,24^FDPASS CODE: ${val}^FS`,
    '^FO35,270^A0N,18,18^FDSCAN AT GATE - DO NOT DUPLICATE^FS',
    '^XZ'
  ];

  return lines.join('\r\n') + '\r\n';
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
