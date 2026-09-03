require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const http = require('http');
const { query } = require('./src/config/db');

function makeRequest({ method, path, headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const postData = body ? JSON.stringify(body) : '';
    const req = http.request(
      {
        hostname: 'localhost',
        port: process.env.PORT || 5006,
        path: `/api${path}`,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(postData ? { 'Content-Length': Buffer.byteLength(postData) } : {}),
          ...headers
        }
      },
      (res) => {
        let raw = '';
        res.on('data', chunk => raw += chunk);
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(raw) });
          } catch (e) {
            resolve({ status: res.statusCode, raw });
          }
        });
      }
    );
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

async function runEventPermissionTests() {
  console.log('================================================================');
  console.log('   EVENT-SCOPED ADMIN PERMISSIONS VERIFICATION SUITE           ');
  console.log('================================================================\n');

  try {
    // 1. Authenticate SuperAdmin and Event Admin
    console.log('[Step 1] Authenticating SuperAdmin & Event Admin...');
    const superLogin = await makeRequest({
      method: 'POST',
      path: '/auth/login',
      body: { email: 'superadmin@eventgen.com', password: 'SuperAdmin@2026!' }
    });
    const superToken = superLogin.body.accessToken;

    const adminLogin = await makeRequest({
      method: 'POST',
      path: '/auth/login',
      body: { email: 'admin@eventgen.com', password: 'Admin@2026!' }
    });
    const adminToken = adminLogin.body.accessToken;
    const adminUserId = adminLogin.body.user.id;

    console.log(`- SuperAdmin Token: Acquired`);
    console.log(`- Event Admin (User ID: ${adminUserId}): Acquired\n`);

    // Fetch all permission IDs from DB
    const allPerms = await query('SELECT id, code FROM permissions');
    const permMap = {};
    allPerms.forEach(p => permMap[p.code] = p.id);

    // 2. Configure Event 1 vs Event 2 strictly in SuperAdmin RBAC Matrix:
    // Event 1 (ID: 1): Billing = ON, Generate Passes = ON, Pass Styles = ON
    // Event 2 (ID: 2): Billing = OFF, Generate Passes = OFF, Pass Styles = OFF
    console.log('[Step 2] SuperAdmin configuring independent permissions for Event 1 & Event 2...');

    const event1PermIds = [
      permMap['dashboard.view'],
      permMap['passes.view'],
      permMap['passes.generate'],
      permMap['pass_styles.view'],
      permMap['billing.create']
    ].filter(Boolean);

    const event2PermIds = [
      permMap['dashboard.view'],
      permMap['passes.view']
      // Notice: billing.create, passes.generate, pass_styles.* are intentionally excluded
    ].filter(Boolean);

    // Save Event 1 permissions
    const saveEv1Res = await makeRequest({
      method: 'PUT',
      path: '/users/event-permissions',
      headers: { Authorization: `Bearer ${superToken}` },
      body: { eventId: 1, userId: adminUserId, permissionIds: event1PermIds }
    });
    console.log(`- Saved Event 1 Permissions (Status: ${saveEv1Res.status}, Message: "${saveEv1Res.body.message}")`);

    // Save Event 2 permissions
    const saveEv2Res = await makeRequest({
      method: 'PUT',
      path: '/users/event-permissions',
      headers: { Authorization: `Bearer ${superToken}` },
      body: { eventId: 2, userId: adminUserId, permissionIds: event2PermIds }
    });
    console.log(`- Saved Event 2 Permissions (Status: ${saveEv2Res.status}, Message: "${saveEv2Res.body.message}")\n`);

    // 3. Test Event 1 Permissions (Should SUCCEED with Status 200 / 201)
    console.log('[Step 3] Testing Admin actions on EVENT 1 (Permissions: ON)...');

    // 3a. Billing on Event 1
    const billEv1Res = await makeRequest({
      method: 'POST',
      path: '/billing/preview',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: { eventId: 1, categoryId: 1, customerName: 'Event1 Buyer', quantity: 1, unitPrice: 100 }
    });
    console.log(`  Case 3a (Event 1 Billing Preview): Status = ${billEv1Res.status} (Success: ${billEv1Res.body.success})`);
    if (billEv1Res.status !== 200) throw new Error(`Expected 200 for Event 1 Billing, got ${billEv1Res.status}`);

    // 3b. Pass Styles on Event 1
    const styleEv1Res = await makeRequest({
      method: 'GET',
      path: '/pass-styles?eventId=1',
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    console.log(`  Case 3b (Event 1 Pass Styles View): Status = ${styleEv1Res.status} (Count: ${styleEv1Res.body.data?.length || 0})`);
    if (styleEv1Res.status !== 200) throw new Error(`Expected 200 for Event 1 Pass Styles, got ${styleEv1Res.status}`);

    console.log('✅ All Event 1 operations permitted and verified!\n');

    // 4. Test Event 2 Permissions (Should be FORBIDDEN with Status 403)
    console.log('[Step 4] Testing Admin actions on EVENT 2 (Permissions: OFF)...');

    // 4a. Billing on Event 2 (Must be 403 Forbidden!)
    const billEv2Res = await makeRequest({
      method: 'POST',
      path: '/billing/preview',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: { eventId: 2, categoryId: 2, customerName: 'Event2 Buyer', quantity: 1, unitPrice: 100 }
    });
    console.log(`  Case 4a (Event 2 Billing Preview): Status = ${billEv2Res.status} (Message: "${billEv2Res.body.message}")`);
    if (billEv2Res.status !== 403) {
      throw new Error(`CRITICAL: Expected 403 Forbidden on Event 2 Billing, but got ${billEv2Res.status}!`);
    }

    // 4b. Pass Styles on Event 2 (Must be 403 Forbidden!)
    const styleEv2Res = await makeRequest({
      method: 'GET',
      path: '/pass-styles?eventId=2',
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    console.log(`  Case 4b (Event 2 Pass Styles View): Status = ${styleEv2Res.status} (Message: "${styleEv2Res.body.message}")`);
    if (styleEv2Res.status !== 403) {
      throw new Error(`CRITICAL: Expected 403 Forbidden on Event 2 Pass Styles, but got ${styleEv2Res.status}!`);
    }

    console.log('✅ Strict 403 Forbidden isolation on Event 2 verified!\n');

    // 5. Test Dynamic Multi-Event Updates:
    // SuperAdmin turns ON Billing on Event 2 -> Verify Event 2 now succeeds, while Event 1 remains unchanged!
    console.log('[Step 5] Dynamic Update: SuperAdmin enabling Billing specifically on Event 2...');
    const updatedEvent2PermIds = [...event2PermIds, permMap['billing.create']];
    await makeRequest({
      method: 'PUT',
      path: '/users/event-permissions',
      headers: { Authorization: `Bearer ${superToken}` },
      body: { eventId: 2, userId: adminUserId, permissionIds: updatedEvent2PermIds }
    });

    const billEv2UpdatedRes = await makeRequest({
      method: 'POST',
      path: '/billing/preview',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: { eventId: 2, categoryId: 2, customerName: 'Event2 Buyer', quantity: 1, unitPrice: 100 }
    });
    console.log(`  Case 5 (Event 2 Billing after enabling): Status = ${billEv2UpdatedRes.status} (Success: ${billEv2UpdatedRes.body.success})`);
    if (billEv2UpdatedRes.status !== 200) {
      throw new Error(`Expected 200 for Event 2 Billing after enabling, got ${billEv2UpdatedRes.status}`);
    }

    console.log('================================================================');
    console.log('   EVENT-BASED PERMISSION ISOLATION PASSED 100%!               ');
    console.log('================================================================');
    process.exit(0);
  } catch (err) {
    console.error('\n❌ Test Failure:', err.message);
    process.exit(1);
  }
}

runEventPermissionTests();
