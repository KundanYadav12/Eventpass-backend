/**
 * TSPL2 Command Language Generator for TSC TE244 and compatible thermal printers
 * 
 * Specifications:
 * - Sticker Size: Configurable, Default 38mm width × 50mm height (304 × 400 dots @ 203 DPI)
 * - 2-Up Dual Column Stock: ~80mm width across roll (2x 38mm labels + 4mm gap)
 * - Supported Barcode Patterns:
 *    - 'QR_CODE' / 'QR' (2D QRCODE with pass code text beneath)
 *    - 'CODE128' (1D Barcode with pass code text beneath)
 *    - 'CODE39' (1D Barcode with pass code text beneath)
 * - Pure ASCII Sanitization & strictly CRLF (\r\n) line endings
 */

function sanitizeAscii(str) {
  if (!str) return '';
  return String(str)
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2022\u2023\u25E6\u2043\u2219]/g, '-')
    .replace(/[^\x20-\x7E]/g, '')
    .trim();
}

/**
 * Generate TSPL for a single label element at offset xOffset
 */
function buildLabelCommands(pass, xOffset = 0, options = {}) {
  const {
    pattern = 'QR_CODE',
    widthMm = 38,
    heightMm = 50
  } = options;

  const code = sanitizeAscii(pass.code || 'PASS001').toUpperCase();
  const qrData = sanitizeAscii(pass.qr_data || pass.signed_code || code);

  // Width in dots: 38mm = ~304 dots. Height in dots: 50mm = ~400 dots
  const labelWidthDots = Math.round(widthMm * 8);
  const labelHeightDots = Math.round(heightMm * 8);
  const boxRight = xOffset + labelWidthDots - 8;
  const boxBottom = labelHeightDots - 8;

  const lines = [];
  const upperPattern = String(pattern || pass.barcode_pattern || 'QR_CODE').toUpperCase();

  if (upperPattern === 'CODE128' || upperPattern === '128') {
    lines.push(`BARCODE ${xOffset + 32},60,"128",140,0,0,2,4,"${code}"`);
    lines.push(`TEXT ${xOffset + 92},235,"2",0,1,1,"PASS CODE:"`);
    lines.push(`TEXT ${xOffset + 96},270,"3",0,1,1,"${code}"`);
  } else if (upperPattern === 'CODE39' || upperPattern === '39') {
    lines.push(`BARCODE ${xOffset + 32},60,"39",140,0,0,2,4,"${code}"`);
    lines.push(`TEXT ${xOffset + 92},235,"2",0,1,1,"PASS CODE:"`);
    lines.push(`TEXT ${xOffset + 96},270,"3",0,1,1,"${code}"`);
  } else {
    // High-contrast, scannable QR Code centered with wide quiet zones
    lines.push(`QRCODE ${xOffset + 89},35,M,6,A,0,"${qrData}"`);
    lines.push(`TEXT ${xOffset + 92},235,"2",0,1,1,"PASS CODE:"`);
    lines.push(`TEXT ${xOffset + 96},270,"3",0,1,1,"${code}"`);
  }

  // Outer Box
  lines.push(`BOX ${xOffset + 8},8,${boxRight},${boxBottom},2`);

  return lines;
}

/**
 * Generate TSPL for a Single 38mm x 50mm Pass
 */
function generateSinglePass(pass, options = {}) {
  const {
    widthMm = 38,
    heightMm = 50,
    gapMm = 3,
    speed = 4,
    density = 8,
    direction = 1
  } = options;

  const lines = [
    `SIZE 80 mm, ${heightMm} mm`,
    `GAP ${gapMm} mm, 0 mm`,
    `SPEED ${speed}`,
    `DENSITY ${density}`,
    `DIRECTION ${direction}`,
    'REFERENCE 0,0',
    'SET TEAR ON',
    'SET PAUSE OFF',
    'CLS',
    ...buildLabelCommands(pass, 0, options),
    'PRINT 1,1'
  ];

  return lines.join('\r\n') + '\r\n';
}

/**
 * Generate TSPL for 2 Passes Across (2-Up 38mm x 50mm on ~80mm roll)
 */
function generateDualColumnPasses(pass1, pass2, options = {}) {
  const {
    widthMm = 38,
    heightMm = 50,
    gapMm = 3,
    columnGapMm = 4,
    speed = 4,
    density = 8,
    direction = 1
  } = options;

  const totalWidthMm = (widthMm * 2) + columnGapMm; // 38 + 38 + 4 = 80mm
  const rightColumnOffsetDots = Math.round((widthMm + columnGapMm) * 8); // (38 + 4) * 8 = 336 dots

  const lines = [
    `SIZE ${totalWidthMm} mm, ${heightMm} mm`,
    `GAP ${gapMm} mm, 0 mm`,
    `SPEED ${speed}`,
    `DENSITY ${density}`,
    `DIRECTION ${direction}`,
    'REFERENCE 0,0',
    'SET TEAR ON',
    'SET PAUSE OFF',
    'CLS'
  ];

  if (pass1) {
    lines.push(...buildLabelCommands(pass1, 0, options));
  }
  if (pass2) {
    lines.push(...buildLabelCommands(pass2, rightColumnOffsetDots, options));
  }

  lines.push('PRINT 1,1');
  return lines.join('\r\n') + '\r\n';
}

/**
 * Generate Batch Payload with Header Sent ONLY ONCE
 */
function generateBatch(passes = [], options = {}) {
  if (!passes || passes.length === 0) return '';
  const {
    widthMm = 38,
    heightMm = 50,
    gapMm = 3,
    columnGapMm = 4,
    speed = 4,
    density = 8,
    direction = 1,
    dualColumn = true
  } = options;

  const totalWidthMm = (widthMm * 2) + columnGapMm;
  const rightColumnOffsetDots = Math.round((widthMm + columnGapMm) * 8);

  const lines = [
    `SIZE ${totalWidthMm} mm, ${heightMm} mm`,
    `GAP ${gapMm} mm, 0 mm`,
    `SPEED ${speed}`,
    `DENSITY ${density}`,
    `DIRECTION ${direction}`,
    'REFERENCE 0,0',
    'OFFSET 0 mm',
    'SET TEAR ON',
    'SET PAUSE OFF'
  ];

  // Deduplicate passes array
  const seenCodes = new Set();
  const uniquePasses = [];
  for (const p of passes) {
    if (!p || !p.code) continue;
    const cleanCode = sanitizeAscii(p.code).toUpperCase();
    if (!seenCodes.has(cleanCode)) {
      seenCodes.add(cleanCode);
      uniquePasses.push(p);
    }
  }

  if (dualColumn) {
    for (let i = 0; i < uniquePasses.length; i += 2) {
      const p1 = uniquePasses[i];
      const p2 = uniquePasses[i + 1] || null;

      lines.push('CLS');
      if (p1) lines.push(...buildLabelCommands(p1, 0, options));
      if (p2 && (!p1 || p2.code !== p1.code)) {
        lines.push(...buildLabelCommands(p2, rightColumnOffsetDots, options));
      }
      lines.push('PRINT 1,1');
    }
  } else {
    for (const p of uniquePasses) {
      lines.push('CLS');
      lines.push(...buildLabelCommands(p, 0, options));
      lines.push('PRINT 1,1');
    }
  }

  return lines.join('\r\n') + '\r\n';
}

/**
 * Generate Dedicated Single Physical Barcode/QR Test Label (38mm x 50mm)
 */
function generateSingleBarcode(barcodeValue = '55KDBD2', eventName = 'EVENTGEN 2026', category = 'VIP PASS', options = {}) {
  const dummyPass = {
    code: barcodeValue,
    event_name: eventName,
    category_name: category,
    valid_date_label: 'VALID: 2026',
    qr_data: barcodeValue,
    barcode_pattern: options.pattern || 'CODE128'
  };

  return generateSinglePass(dummyPass, options);
}

/**
 * Generate Media Gap Calibration Command
 */
function generateCalibration(options = {}) {
  const gapMm = options.gapMm || 3;
  return [
    'SIZE 80 mm, 50 mm',
    `GAP ${gapMm} mm, 0 mm`,
    'DIRECTION 1',
    'REFERENCE 0,0',
    'GAPDETECT',
    'AUTODETECT',
    'FORMFEED',
    ''
  ].join('\r\n');
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
