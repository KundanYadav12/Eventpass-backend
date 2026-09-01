/**
 * TSPL2 Command Language Generator for TSC TE244 and compatible thermal printers
 * 
 * Supports:
 * - 50mm x 50mm stock (Single & 2-Up Dual Column across 104mm width)
 * - Code 128 Barcodes (BARCODE) & 2D QR Codes (QRCODE)
 * - Pure ASCII Sanitization
 * - CRLF Line Endings
 * - Media Gap Calibration & Hardware Unpause
 */

function sanitizeAscii(str) {
  if (!str) return '';
  return String(str)
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2022\u2023\u25E6\u2043\u2219]/g, '-')
    .replace(/[^\x20-\x7E]/g, '');
}

/**
 * Generate TSPL for a Single 50mm x 50mm Pass (Dual or Single Column)
 */
function generateSinglePass(pass, options = {}) {
  const {
    gapMm = 3,
    speed = 4,
    density = 8,
    direction = 1
  } = options;

  const code = sanitizeAscii(pass.code || 'PASS001');
  const eventName = sanitizeAscii(pass.event_name || 'EVENTGEN 2026').substring(0, 20);
  const categoryName = sanitizeAscii(pass.category_name || 'VIP').substring(0, 16);
  const dateLabel = sanitizeAscii(pass.valid_date_label || 'VALID 2026').substring(0, 16);
  const qrData = sanitizeAscii(pass.qr_data || pass.signed_code || code);

  const lines = [
    'SIZE 50 mm, 50 mm',
    `GAP ${gapMm} mm, 0 mm`,
    `SPEED ${speed}`,
    `DENSITY ${density}`,
    `DIRECTION ${direction}`,
    'REFERENCE 0,0',
    'SET TEAR ON',
    'CLS',
    `TEXT 20,20,"2",0,1,1,"${eventName}"`,
    `TEXT 20,48,"3",0,1,1,"${categoryName}"`,
    `QRCODE 25,85,L,5,A,0,"${qrData}"`,
    'TEXT 180,105,"2",0,1,1,"PASS CODE:"',
    `TEXT 180,135,"4",0,1,1,"${code}"`,
    `TEXT 20,295,"2",0,1,1,"${dateLabel}"`,
    'TEXT 20,330,"1",0,1,1,"DO NOT DUPLICATE - SCANNABLE"',
    'BOX 10,10,390,390,2',
    'PRINT 1,1'
  ];

  return lines.join('\r\n') + '\r\n';
}

/**
 * Generate TSPL for 2 Passes Across (2-Up 50mm x 50mm on 104mm roll)
 */
function generateDualColumnPasses(pass1, pass2, options = {}) {
  const {
    gapMm = 3,
    speed = 4,
    density = 8,
    direction = 1
  } = options;

  const lines = [
    'SIZE 104 mm, 50 mm',
    `GAP ${gapMm} mm, 0 mm`,
    `SPEED ${speed}`,
    `DENSITY ${density}`,
    `DIRECTION ${direction}`,
    'REFERENCE 0,0',
    'SET TEAR ON',
    'CLS'
  ];

  const addLabelToStream = (pass, xOffset) => {
    if (!pass) return;
    const code = sanitizeAscii(pass.code || 'PASS001');
    const eventName = sanitizeAscii(pass.event_name || 'EVENTGEN 2026').substring(0, 20);
    const categoryName = sanitizeAscii(pass.category_name || 'VIP').substring(0, 16);
    const dateLabel = sanitizeAscii(pass.valid_date_label || 'VALID 2026').substring(0, 16);
    const qrData = sanitizeAscii(pass.qr_data || pass.signed_code || code);

    lines.push(`TEXT ${xOffset + 20},20,"2",0,1,1,"${eventName}"`);
    lines.push(`TEXT ${xOffset + 20},48,"3",0,1,1,"${categoryName}"`);
    lines.push(`QRCODE ${xOffset + 25},85,L,5,A,0,"${qrData}"`);
    lines.push(`TEXT ${xOffset + 180},105,"2",0,1,1,"PASS CODE:"`);
    lines.push(`TEXT ${xOffset + 180},135,"4",0,1,1,"${code}"`);
    lines.push(`TEXT ${xOffset + 20},295,"2",0,1,1,"${dateLabel}"`);
    lines.push(`TEXT ${xOffset + 20},330,"1",0,1,1,"DO NOT DUPLICATE - SCANNABLE"`);
    lines.push(`BOX ${xOffset + 10},10,${xOffset + 390},390,2`);
  };

  addLabelToStream(pass1, 0);
  if (pass2) {
    addLabelToStream(pass2, 420); // 420 dots offset ~ 52.5mm
  }

  lines.push('PRINT 1,1');
  return lines.join('\r\n') + '\r\n';
}

/**
 * Generate Batch Payload
 */
function generateBatch(passes = [], options = {}) {
  const dualColumn = options.dualColumn !== false;
  if (!dualColumn) {
    return passes.map(p => generateSinglePass(p, options)).join('');
  }

  let batchTspl = '';
  for (let i = 0; i < passes.length; i += 2) {
    const p1 = passes[i];
    const p2 = passes[i + 1] || null;
    batchTspl += generateDualColumnPasses(p1, p2, options);
  }
  return batchTspl;
}

/**
 * Generate Dedicated Single Physical Code 128 Barcode Test Label
 */
function generateSingleBarcode(barcodeValue = '55KDBD2', eventName = 'EVENTGEN 2026', category = 'VIP PASS', options = {}) {
  const {
    gapMm = 3,
    speed = 4,
    density = 8,
    direction = 1
  } = options;

  const val = sanitizeAscii(barcodeValue);
  const ev = sanitizeAscii(eventName).substring(0, 20);
  const cat = sanitizeAscii(category).substring(0, 16);

  const lines = [
    'SIZE 50 mm, 50 mm',
    `GAP ${gapMm} mm, 0 mm`,
    `SPEED ${speed}`,
    `DENSITY ${density}`,
    `DIRECTION ${direction}`,
    'REFERENCE 0,0',
    'SET TEAR ON',
    'CLS',
    `TEXT 35,30,"3",0,1,1,"${ev}"`,
    `TEXT 35,60,"2",0,1,1,"${cat}"`,
    `BARCODE 35,95,"128",85,2,0,2,4,"${val}"`,
    `TEXT 35,215,"2",0,1,1,"PASS CODE: ${val}"`,
    'TEXT 35,250,"1",0,1,1,"SCAN AT GATE - DO NOT DUPLICATE"',
    'BOX 15,15,385,385,2',
    'PRINT 1,1'
  ];

  return lines.join('\r\n') + '\r\n';
}

/**
 * Generate Media Gap Calibration Command
 */
function generateCalibration(options = {}) {
  return 'GAP-DETECT\r\nFEED 1\r\n';
}

/**
 * Generate Unpause Command
 */
function generateUnpause() {
  return 'SET PAUSE OFF\r\nRESUME\r\n';
}

module.exports = {
  language: 'TSPL',
  generateSinglePass,
  generateDualColumnPasses,
  generateBatch,
  generateSingleBarcode,
  generateCalibration,
  generateUnpause,
  sanitizeAscii
};
