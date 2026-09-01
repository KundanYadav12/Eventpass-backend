/**
 * TSC TE244 TSPL / TSPL2 Label Generator
 * 
 * Specifications:
 * - Single Label: 50mm x 50mm (400 x 400 dots @ 203 DPI)
 * - 2-Up Stock (Dual Column): 104mm width total (2x 50mm labels + 3mm gap)
 * - Pure ASCII command stream with strictly CRLF (\r\n) line endings
 */

const DEFAULT_CONFIG = {
  widthMm: 50,
  heightMm: 50,
  dualWidthMm: 104,
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
    .replace(/[\u2022\u2023\u25E6\u2043\u2219]/g, '-') // bullet to hyphen
    .replace(/[^\x20-\x7E]/g, '') // remove non-printable ASCII
    .trim();
}

/**
 * Generate a single 50mm x 50mm TSPL label command string
 * @param {Object} pass
 * @param {string} pass.code - 7-character unique pass code (e.g. "55KDBD2")
 * @param {string} [pass.category_name]
 * @param {string} [pass.event_name]
 * @param {string} [pass.valid_date_label]
 * @param {Object} [options]
 * @returns {string} Raw TSPL commands
 */
function generateTsplLabel(pass, options = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...options };
  const commands = [];

  const code = sanitizeAscii(pass.code || 'TEST001').toUpperCase();
  const eventName = sanitizeAscii(pass.event_name || 'EVENTGEN 2026').toUpperCase().slice(0, 20);
  const categoryName = sanitizeAscii(pass.category_name || pass.code_type || 'PASS').toUpperCase();
  const validity = sanitizeAscii(pass.valid_date_label || 'VALID: 2026');

  // TSPL Setup Commands
  commands.push(`SIZE ${cfg.widthMm} mm, ${cfg.heightMm} mm`);
  commands.push(`GAP ${cfg.gapMm} mm, 0 mm`);
  commands.push(`SPEED ${cfg.speed}`);
  commands.push(`DENSITY ${cfg.density}`);
  commands.push(`DIRECTION ${cfg.direction}`);
  commands.push('REFERENCE 0,0');
  commands.push('SET TEAR ON');
  commands.push('CLS');

  // Header: Event & Category
  commands.push(`TEXT 20,20,"2",0,1,1,"${eventName}"`);
  commands.push(`TEXT 20,48,"3",0,1,1,"${categoryName}"`);

  // QR Code (x=25, y=85, ECC=L, cell_width=5, mode=A, rotation=0)
  commands.push(`QRCODE 25,85,L,5,A,0,"${code}"`);

  // 7-Character Pass Code Display
  commands.push(`TEXT 180,105,"2",0,1,1,"PASS CODE:"`);
  commands.push(`TEXT 180,135,"4",0,1,1,"${code}"`);

  // Validity & Footer
  commands.push(`TEXT 20,295,"2",0,1,1,"${validity}"`);
  commands.push(`TEXT 20,330,"1",0,1,1,"DO NOT DUPLICATE - SCANNABLE"`);

  // Outer Border Box
  commands.push('BOX 10,10,390,390,2');

  // Print 1 label
  commands.push('PRINT 1,1');

  return commands.join('\r\n') + '\r\n';
}

/**
 * Generate 2-Up (dual column across) TSPL label commands
 * @param {Object} leftPass
 * @param {Object} [rightPass]
 * @param {Object} [options]
 * @returns {string} Raw TSPL commands
 */
function generateTsplForPassPair(leftPass, rightPass = null, options = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...options };
  const commands = [];

  // TSPL Setup Commands for 104mm dual column
  commands.push(`SIZE ${cfg.dualWidthMm} mm, ${cfg.heightMm} mm`);
  commands.push(`GAP ${cfg.gapMm} mm, 0 mm`);
  commands.push(`SPEED ${cfg.speed}`);
  commands.push(`DENSITY ${cfg.density}`);
  commands.push(`DIRECTION ${cfg.direction}`);
  commands.push('REFERENCE 0,0');
  commands.push('SET TEAR ON');
  commands.push('CLS');

  // Left Label (X: 16 to 390)
  if (leftPass) {
    const x = 16;
    const code = sanitizeAscii(leftPass.code || '').toUpperCase();
    const eventName = sanitizeAscii(leftPass.event_name || 'EVENTGEN 2026').toUpperCase().slice(0, 20);
    const categoryName = sanitizeAscii(leftPass.category_name || leftPass.code_type || 'PASS').toUpperCase();
    const validity = sanitizeAscii(leftPass.valid_date_label || '2026');

    commands.push(`TEXT ${x + 10},15,"2",0,1,1,"${eventName}"`);
    commands.push(`TEXT ${x + 10},44,"3",0,1,1,"${categoryName}"`);
    commands.push(`QRCODE ${x + 15},80,L,5,A,0,"${code}"`);
    commands.push(`TEXT ${x + 165},100,"2",0,1,1,"PASS CODE:"`);
    commands.push(`TEXT ${x + 165},130,"4",0,1,1,"${code}"`);
    commands.push(`TEXT ${x + 10},290,"2",0,1,1,"VALID: ${validity}"`);
    commands.push(`TEXT ${x + 10},325,"1",0,1,1,"DO NOT DUPLICATE"`);
    commands.push(`BOX ${x},5,${x + 375},385,2`);
  }

  // Right Label (X: 430 to 804)
  if (rightPass) {
    const x = 430;
    const code = sanitizeAscii(rightPass.code || '').toUpperCase();
    const eventName = sanitizeAscii(rightPass.event_name || 'EVENTGEN 2026').toUpperCase().slice(0, 20);
    const categoryName = sanitizeAscii(rightPass.category_name || rightPass.code_type || 'PASS').toUpperCase();
    const validity = sanitizeAscii(rightPass.valid_date_label || '2026');

    commands.push(`TEXT ${x + 10},15,"2",0,1,1,"${eventName}"`);
    commands.push(`TEXT ${x + 10},44,"3",0,1,1,"${categoryName}"`);
    commands.push(`QRCODE ${x + 15},80,L,5,A,0,"${code}"`);
    commands.push(`TEXT ${x + 165},100,"2",0,1,1,"PASS CODE:"`);
    commands.push(`TEXT ${x + 165},130,"4",0,1,1,"${code}"`);
    commands.push(`TEXT ${x + 10},290,"2",0,1,1,"VALID: ${validity}"`);
    commands.push(`TEXT ${x + 10},325,"1",0,1,1,"DO NOT DUPLICATE"`);
    commands.push(`BOX ${x},5,${x + 375},385,2`);
  }

  // Print 1 label row
  commands.push('PRINT 1,1');

  return commands.join('\r\n') + '\r\n';
}

/**
 * Generate full TSPL batch script for an array of passes
 * @param {Array} passes 
 * @param {Object} [options]
 * @returns {string} Complete TSPL script
 */
function generateTsplBatch(passes, options = {}) {
  let fullScript = '';
  for (let i = 0; i < passes.length; i += 2) {
    const left = passes[i];
    const right = passes[i + 1] || null;
    fullScript += generateTsplForPassPair(left, right, options) + '\r\n';
  }
  return fullScript;
}

/**
 * Generate a Dummy / Sample Test Label for Printer Connectivity Verification
 * @param {Object} [options]
 * @returns {string} TSPL sample commands
 */
function generateDummyTestLabel(options = {}) {
  const dummyPass = {
    code: 'TEST244',
    event_name: 'TSC PRINTER TEST',
    category_name: '50MM TEST PASS',
    valid_date_label: new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
  };

  return generateTsplLabel(dummyPass, options);
}

/**
 * Generate Media Gap Calibration command (GAP-DETECT + FEED)
 */
function generateCalibrationCommand() {
  return 'GAP-DETECT\r\nFEED 1\r\n';
}

/**
 * Generate Unpause / Resume command
 */
function generateUnpauseCommand() {
  return 'SET PAUSE OFF\r\nRESUME\r\n';
}

module.exports = {
  generateTsplLabel,
  generateTsplForPassPair,
  generateTsplBatch,
  generateDummyTestLabel,
  generateCalibrationCommand,
  generateUnpauseCommand,
  DEFAULT_CONFIG
};
