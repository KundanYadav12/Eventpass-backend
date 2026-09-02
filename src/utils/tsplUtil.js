/**
 * TSC TE244 TSPL / TSPL2 Label Generator
 * 
 * Specifications:
 * - Single Label: 38mm x 50mm (304 x 400 dots @ 203 DPI)
 * - 2-Up Stock (Dual Column): ~80mm width total (2x 38mm labels + 4mm gap)
 * - Pure ASCII command stream with strictly CRLF (\r\n) line endings
 */

const DEFAULT_CONFIG = {
  widthMm: 38,
  heightMm: 50,
  dualWidthMm: 80,
  gapMm: parseFloat(process.env.TSPL_GAP_MM || '3'),
  speed: parseInt(process.env.TSPL_SPEED || '4', 10),
  density: parseInt(process.env.TSPL_DENSITY || '8', 10),
  direction: parseInt(process.env.TSPL_DIRECTION || '1', 10),
  referenceX: 0,
  referenceY: 0
};

/**
 * Sanitize text to pure ASCII for TSPL bitmap character generators
 */
function sanitizeAscii(str) {
  if (!str) return '';
  return String(str)
    .replace(/[\u2022\u2023\u25E6\u2043\u2219]/g, '-')
    .replace(/[^\x20-\x7E]/g, '')
    .trim();
}

/**
 * Generate a single 38mm x 50mm TSPL label command string
 */
function generateTsplLabel(pass, options = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...options };
  const commands = [];

  const code = sanitizeAscii(pass.code || 'TEST001').toUpperCase();
  const qrData = sanitizeAscii(pass.qr_data || pass.signed_code || code);
  const pattern = (options.pattern || pass.barcode_pattern || 'QR_CODE').toUpperCase();

  // TSPL Setup Commands
  commands.push(`SIZE ${cfg.widthMm} mm, ${cfg.heightMm} mm`);
  commands.push(`GAP ${cfg.gapMm} mm, 0 mm`);
  commands.push(`SPEED ${cfg.speed}`);
  commands.push(`DENSITY ${cfg.density}`);
  commands.push(`DIRECTION ${cfg.direction}`);
  commands.push('REFERENCE 0,0');
  commands.push('SET TEAR ON');
  commands.push('CLS');

  if (pattern === 'CODE128' || pattern === '128') {
    commands.push(`BARCODE 16,100,"128",130,0,0,2,4,"${code}"`);
    commands.push(`TEXT 16,265,"3",0,1,1,"PASS CODE: ${code}"`);
  } else if (pattern === 'CODE39' || pattern === '39') {
    commands.push(`BARCODE 16,100,"39",130,0,0,2,4,"${code}"`);
    commands.push(`TEXT 16,265,"3",0,1,1,"PASS CODE: ${code}"`);
  } else {
    // QR Code
    commands.push(`QRCODE 55,60,L,6,A,0,"${qrData}"`);
    commands.push(`TEXT 16,275,"3",0,1,1,"PASS CODE: ${code}"`);
  }

  // Outer Border Box
  commands.push('BOX 8,8,294,390,2');

  // Print 1 label
  commands.push('PRINT 1,1');

  return commands.join('\r\n') + '\r\n';
}

/**
 * Generate 2-Up (dual column across) TSPL label commands
 */
function generateTsplForPassPair(leftPass, rightPass = null, options = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...options };
  const commands = [];

  // TSPL Setup Commands for 80mm dual column
  commands.push(`SIZE ${cfg.dualWidthMm} mm, ${cfg.heightMm} mm`);
  commands.push(`GAP ${cfg.gapMm} mm, 0 mm`);
  commands.push(`SPEED ${cfg.speed}`);
  commands.push(`DENSITY ${cfg.density}`);
  commands.push(`DIRECTION ${cfg.direction}`);
  commands.push('REFERENCE 0,0');
  commands.push('SET TEAR ON');
  commands.push('CLS');

  const addLabel = (pass, xOffset) => {
    if (!pass) return;
    const code = sanitizeAscii(pass.code || '').toUpperCase();
    const qrData = sanitizeAscii(pass.qr_data || pass.signed_code || code);
    const pattern = (options.pattern || pass.barcode_pattern || 'QR_CODE').toUpperCase();

    if (pattern === 'CODE128' || pattern === '128') {
      commands.push(`BARCODE ${xOffset + 16},100,"128",130,0,0,2,4,"${code}"`);
      commands.push(`TEXT ${xOffset + 16},265,"3",0,1,1,"PASS CODE: ${code}"`);
    } else if (pattern === 'CODE39' || pattern === '39') {
      commands.push(`BARCODE ${xOffset + 16},100,"39",130,0,0,2,4,"${code}"`);
      commands.push(`TEXT ${xOffset + 16},265,"3",0,1,1,"PASS CODE: ${code}"`);
    } else {
      commands.push(`QRCODE ${xOffset + 55},60,L,6,A,0,"${qrData}"`);
      commands.push(`TEXT ${xOffset + 16},275,"3",0,1,1,"PASS CODE: ${code}"`);
    }

    commands.push(`BOX ${xOffset + 8},8,${xOffset + 294},390,2`);
  };

  addLabel(leftPass, 0);
  if (rightPass) {
    addLabel(rightPass, 336); // 336 dots offset (~42mm)
  }

  commands.push('PRINT 1,1');
  return commands.join('\r\n') + '\r\n';
}

/**
 * Generate TSPL stream for an entire batch of passes
 */
function generateTsplForBatch(passes, options = {}) {
  if (!Array.isArray(passes) || passes.length === 0) {
    return '';
  }

  const useDualColumn = options.dualColumn !== false;
  if (!useDualColumn) {
    return passes.map(p => generateTsplLabel(p, options)).join('');
  }

  let fullStream = '';
  for (let i = 0; i < passes.length; i += 2) {
    const left = passes[i];
    const right = (i + 1 < passes.length) ? passes[i + 1] : null;
    fullStream += generateTsplForPassPair(left, right, options);
  }
  return fullStream;
}

module.exports = {
  DEFAULT_CONFIG,
  sanitizeAscii,
  generateTsplLabel,
  generateTsplForPassPair,
  generateTsplForBatch
};
