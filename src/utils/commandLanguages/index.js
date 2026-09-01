/**
 * Pluggable Command Language Architecture Factory
 * 
 * Supported Command Languages:
 * - TSPL (TSC, Gprinter, Rongta, etc.)
 * - ZPL (Zebra, ZDesigner, Citizen, Datamax)
 * - ESCPOS (Epson, POS-58, POS-80, Bixolon, Star)
 * - GENERIC_TEXT (Generic Windows Text Spooler)
 */

const tsplGenerator = require('./tsplGenerator');
const zplGenerator = require('./zplGenerator');
const escposGenerator = require('./escposGenerator');
const genericGenerator = require('./genericGenerator');

const registry = {
  TSPL: tsplGenerator,
  ZPL: zplGenerator,
  ESCPOS: escposGenerator,
  GENERIC_TEXT: genericGenerator,
  TEXT: genericGenerator
};

/**
 * Automatically detect best command language based on printer or driver name
 */
function detectLanguageFromDriver(printerName = '', driverName = '') {
  const combined = `${printerName} ${driverName}`.toLowerCase();

  if (combined.includes('tsc') || combined.includes('te244') || combined.includes('ttp-') || combined.includes('gprinter')) {
    return 'TSPL';
  }
  if (combined.includes('zebra') || combined.includes('zdesigner') || combined.includes('zd420') || combined.includes('gk420') || combined.includes('zt230')) {
    return 'ZPL';
  }
  if (combined.includes('epson') || combined.includes('tm-t') || combined.includes('pos-') || combined.includes('receipt') || combined.includes('bixolon') || combined.includes('star')) {
    return 'ESCPOS';
  }

  return 'TSPL'; // Default to TSPL
}

/**
 * Get command generator for the specified language
 * @param {string} [language='TSPL']
 * @returns {object} Generator module
 */
function getGenerator(language = 'TSPL') {
  const normalized = (language || 'TSPL').trim().toUpperCase();
  return registry[normalized] || tsplGenerator;
}

module.exports = {
  getGenerator,
  getCommandGenerator: getGenerator,
  detectLanguageFromDriver,
  supportedLanguages: Object.keys(registry)
};
