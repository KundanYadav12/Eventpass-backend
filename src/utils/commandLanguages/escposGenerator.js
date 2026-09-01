/**
 * ESC/POS Command Language Generator for POS, Receipt & Ticket Thermal Printers
 * (Epson, Bixolon, Star, Rongta, POS-58, POS-80)
 */

function sanitizeAscii(str) {
  if (!str) return '';
  return String(str)
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[^\x20-\x7E]/g, '');
}

/**
 * Generate ESC/POS for a single pass
 */
function generateSinglePass(pass, options = {}) {
  const code = sanitizeAscii(pass.code || 'PASS001');
  const eventName = sanitizeAscii(pass.event_name || 'EVENTGEN 2026');
  const categoryName = sanitizeAscii(pass.category_name || 'GENERAL');
  const dateLabel = sanitizeAscii(pass.valid_date_label || 'VALID 2026');

  // ESC/POS raw command buffer
  let cmds = '';
  // ESC @: Initialize
  cmds += '\x1B\x40';
  // ESC a 1: Center alignment
  cmds += '\x1B\x61\x01';
  // ESC E 1: Bold on
  cmds += '\x1B\x45\x01';
  // Double height/width for event name
  cmds += '\x1D\x21\x11' + eventName + '\n';
  cmds += '\x1D\x21\x00' + categoryName + '\n\n';
  // Bold off
  cmds += '\x1B\x45\x00';

  // Code 128 Barcode: GS k 73 [len] [data] (Type 73 = Code 128)
  // GS h 80 (Height 80)
  cmds += '\x1D\x68\x50';
  // GS w 2 (Module width 2)
  cmds += '\x1D\x77\x02';
  // GS H 2 (Human readable below barcode)
  cmds += '\x1D\x48\x02';
  // Barcode data with Code 128 subset B preamble '{B'
  const code128Payload = '{B' + code;
  cmds += '\x1D\x6B\x49' + String.fromCharCode(code128Payload.length) + code128Payload;

  cmds += '\n\n' + dateLabel + '\n';
  cmds += 'DO NOT DUPLICATE - GATE SCANNABLE\n';
  cmds += '--------------------------------\n\n\n';
  // GS V 66 0: Partial Cut
  cmds += '\x1D\x56\x42\x00';

  return cmds;
}

/**
 * Generate ESC/POS for Batch
 */
function generateBatch(passes = [], options = {}) {
  return passes.map(p => generateSinglePass(p, options)).join('');
}

/**
 * Generate Single Barcode Test in ESC/POS
 */
function generateSingleBarcode(barcodeValue = '55KDBD2', eventName = 'EVENTGEN 2026', category = 'VIP PASS', options = {}) {
  const val = sanitizeAscii(barcodeValue);
  const ev = sanitizeAscii(eventName);
  const cat = sanitizeAscii(category);

  let cmds = '';
  cmds += '\x1B\x40';
  cmds += '\x1B\x61\x01';
  cmds += '\x1B\x45\x01';
  cmds += '\x1D\x21\x11' + ev + '\n';
  cmds += '\x1D\x21\x00' + cat + '\n\n';
  cmds += '\x1B\x45\x00';

  cmds += '\x1D\x68\x50';
  cmds += '\x1D\x77\x02';
  cmds += '\x1D\x48\x02';
  const code128Payload = '{B' + val;
  cmds += '\x1D\x6B\x49' + String.fromCharCode(code128Payload.length) + code128Payload;

  cmds += '\n\nCODE: ' + val + '\n';
  cmds += 'TEST BARCODE - SCAN AT GATE\n';
  cmds += '--------------------------------\n\n\n';
  cmds += '\x1D\x56\x42\x00';

  return cmds;
}

/**
 * Form feed / reset
 */
function generateCalibration(options = {}) {
  return '\x1B\x40\x0C'; // Initialize & Form Feed
}

function generateUnpause() {
  return '\x1B\x40'; // Re-initialize printer
}

module.exports = {
  language: 'ESCPOS',
  generateSinglePass,
  generateBatch,
  generateSingleBarcode,
  generateCalibration,
  generateUnpause,
  sanitizeAscii
};
