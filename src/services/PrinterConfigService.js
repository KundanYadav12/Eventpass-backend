/**
 * Printer Configuration Service
 * 
 * Manages dynamic printer settings in database:
 * - Selected active printer name (Default: 'TSC TE244')
 * - Selected command language (TSPL, ZPL)
 * - Media stock dimensions & calibration values
 * - Gateway Mode & Pairing API Key
 * - Venue Printers catalog
 */

const { query } = require('../config/db');
const { listPrinters: listLocalPrinters } = require('../utils/printerDriver');

/**
 * Get active printer settings
 */
async function getSettings(eventId = null) {
  const rows = await query(
    'SELECT * FROM printer_settings WHERE event_id = ? OR event_id IS NULL ORDER BY event_id DESC LIMIT 1',
    [eventId]
  );

  if (rows && rows.length > 0) {
    return rows[0];
  }

  // Fallback defaults
  return {
    id: 1,
    printer_name: 'TSC TE244',
    command_language: 'TSPL',
    stock_width_mm: 50,
    stock_height_mm: 50,
    dual_column: 1,
    gap_mm: 3.00,
    speed: 4,
    density: 8,
    direction: 1,
    gateway_mode: 0,
    gateway_api_key: 'eventgen_gateway_sec_key_9981'
  };
}

/**
 * Update printer settings
 */
async function updateSettings(settingsData, eventId = null) {
  const {
    printer_name = 'TSC TE244',
    command_language = 'TSPL',
    stock_width_mm = 50,
    stock_height_mm = 50,
    dual_column = 1,
    gap_mm = 3.00,
    speed = 4,
    density = 8,
    direction = 1,
    gateway_mode = 0,
    gateway_api_key = 'eventgen_gateway_sec_key_9981'
  } = settingsData;

  const existing = await query(
    'SELECT id FROM printer_settings WHERE event_id = ? OR (event_id IS NULL AND ? IS NULL) LIMIT 1',
    [eventId, eventId]
  );

  if (existing && existing.length > 0) {
    await query(
      `UPDATE printer_settings SET 
        printer_name = ?, 
        command_language = ?, 
        stock_width_mm = ?, 
        stock_height_mm = ?, 
        dual_column = ?, 
        gap_mm = ?, 
        speed = ?, 
        density = ?, 
        direction = ?, 
        gateway_mode = ?, 
        gateway_api_key = ?,
        updated_at = NOW()
      WHERE id = ?`,
      [
        printer_name,
        command_language.toUpperCase(),
        stock_width_mm,
        stock_height_mm,
        dual_column ? 1 : 0,
        gap_mm,
        speed,
        density,
        direction,
        gateway_mode ? 1 : 0,
        gateway_api_key,
        existing[0].id
      ]
    );
  } else {
    await query(
      `INSERT INTO printer_settings 
        (event_id, printer_name, command_language, stock_width_mm, stock_height_mm, dual_column, gap_mm, speed, density, direction, gateway_mode, gateway_api_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        eventId,
        printer_name,
        command_language.toUpperCase(),
        stock_width_mm,
        stock_height_mm,
        dual_column ? 1 : 0,
        gap_mm,
        speed,
        density,
        direction,
        gateway_mode ? 1 : 0,
        gateway_api_key
      ]
    );
  }

  return await getSettings(eventId);
}

/**
 * Get unified list of available printers:
 * Combines OS-discovered local printers AND remote Venue Gateway reported printers
 */
async function getAllAvailablePrinters() {
  const localPrinters = await listLocalPrinters();
  
  // Also query venue printers reported in last 24 hours
  const remoteRows = await query(
    `SELECT printer_name as name, driver_name as driver, port_name as port, status, gateway_device_id, last_seen_at
     FROM venue_printers
     WHERE last_seen_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)
     ORDER BY last_seen_at DESC`
  );

  const printerMap = new Map();

  // Add local printers
  for (const lp of localPrinters) {
    printerMap.set(lp.name, {
      name: lp.name,
      driver: lp.driver || 'Windows Driver',
      port: lp.port || 'USB001',
      source: 'local_os',
      status: lp.status || 'Normal'
    });
  }

  // Merge remote venue gateway printers
  for (const rp of remoteRows) {
    if (!printerMap.has(rp.name)) {
      printerMap.set(rp.name, {
        name: rp.name,
        driver: rp.driver || 'Gateway Driver',
        port: rp.port || 'USB',
        source: 'venue_gateway',
        gatewayDeviceId: rp.gateway_device_id,
        status: rp.status || 'Normal',
        lastSeen: rp.last_seen_at
      });
    }
  }

  // Ensure default TSC TE244 option exists in map if none detected
  if (printerMap.size === 0 || !printerMap.has('TSC TE244')) {
    printerMap.set('TSC TE244', {
      name: 'TSC TE244',
      driver: 'TSC TE244',
      port: 'USB001',
      source: 'default',
      status: 'Normal'
    });
  }

  return Array.from(printerMap.values());
}

/**
 * Register or update venue printers from Gateway heartbeat
 */
async function recordGatewayPrinters(gatewayDeviceId, printers = []) {
  if (!gatewayDeviceId || !Array.isArray(printers)) return;

  for (const p of printers) {
    if (!p.name) continue;
    await query(
      `INSERT INTO venue_printers (gateway_device_id, printer_name, driver_name, port_name, status, last_seen_at)
       VALUES (?, ?, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE
        driver_name = VALUES(driver_name),
        port_name = VALUES(port_name),
        status = VALUES(status),
        last_seen_at = NOW()`,
      [gatewayDeviceId, p.name, p.driver || null, p.port || null, p.status || 'Normal']
    );
  }

  // Update heartbeat in printer_settings
  await query('UPDATE printer_settings SET last_gateway_heartbeat = NOW() WHERE id = 1');
}

module.exports = {
  getSettings,
  updateSettings,
  getAllAvailablePrinters,
  recordGatewayPrinters
};
