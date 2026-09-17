const { query, withTransaction } = require('../src/config/db');

async function setupScannerRole() {
  console.log('[Setup] Initializing SCANNER role...');

  try {
    // 1. Check if role 4 / 'SCANNER' exists
    const existingRoles = await query("SELECT * FROM roles WHERE id = 4 OR UPPER(name) = 'SCANNER'");
    let scannerRoleId = 4;

    if (existingRoles.length === 0) {
      await query(
        "INSERT INTO roles (id, name, description) VALUES (4, 'SCANNER', 'Dedicated gate scanner account restricted exclusively to pass scanning')"
      );
      console.log('[Setup] Created role: SCANNER (id: 4)');
    } else {
      scannerRoleId = existingRoles[0].id;
      console.log(`[Setup] Role SCANNER already exists with id: ${scannerRoleId}`);
    }

    // 2. Ensure permissions exist for scan.operate (id: 6) and scan.history (id: 7)
    const scanOperate = await query("SELECT id FROM permissions WHERE code = 'scan.operate'");
    const scanHistory = await query("SELECT id FROM permissions WHERE code = 'scan.history'");

    const permIds = [];
    if (scanOperate.length > 0) permIds.push(scanOperate[0].id);
    if (scanHistory.length > 0) permIds.push(scanHistory[0].id);

    // 3. Clear and set role_permissions for SCANNER
    await query("DELETE FROM role_permissions WHERE role_id = ?", [scannerRoleId]);
    for (const pId of permIds) {
      await query(
        "INSERT IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)",
        [scannerRoleId, pId]
      );
    }
    console.log(`[Setup] Assigned permissions [${permIds.join(', ')}] to role SCANNER (id: ${scannerRoleId})`);

    console.log('[Setup] Scanner role configuration completed successfully!');
    process.exit(0);
  } catch (err) {
    console.error('[Setup Error]:', err);
    process.exit(1);
  }
}

setupScannerRole();
