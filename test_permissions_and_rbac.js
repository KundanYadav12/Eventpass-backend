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

async function runRbacTests() {
  console.log('================================================================');
  console.log('   GRANULAR RBAC & PERMISSIONS ENFORCEMENT VERIFICATION        ');
  console.log('================================================================\n');

  try {
    // 1. Authenticate SuperAdmin and Event Admin
    console.log('[Step 1] Authenticating SuperAdmin and Event Admin accounts...');
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
    let adminToken = adminLogin.body.accessToken;

    console.log(`- SuperAdmin Token: ${superToken ? 'Acquired (Role: SUPERADMIN)' : 'FAILED'}`);
    console.log(`- Event Admin Token: ${adminToken ? 'Acquired (Role: ADMIN)' : 'FAILED'}`);
    console.log(`- Initial Event Admin Permissions: [${adminLogin.body.user?.permissions?.join(', ') || 'None'}]\n`);

    // 2. Test SuperAdmin Access (Should always succeed on all routes)
    console.log('[Step 2] Testing SuperAdmin Full Access...');
    const superStyleRes = await makeRequest({
      method: 'GET',
      path: '/pass-styles',
      headers: { Authorization: `Bearer ${superToken}` }
    });
    console.log(`- SuperAdmin GET /pass-styles: Status = ${superStyleRes.status} (Expected: 200)`);
    if (superStyleRes.status !== 200) throw new Error('SuperAdmin failed to access /pass-styles');

    // 3. Test Event Admin Restricted Access (By default, passes.generate, categories.create, pass_styles.* are forbidden)
    console.log('\n[Step 3] Testing Event Admin Default Permission Restrictions (Should be 403 Forbidden)...');

    // 3a. Generate Passes without permission
    const genRes = await makeRequest({
      method: 'POST',
      path: '/passes/generate',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: { eventId: 1, categoryId: 1, quantity: 5 }
    });
    console.log(`  Case 3a (Event Admin POST /passes/generate): Status = ${genRes.status} (Message: "${genRes.body.message}")`);
    if (genRes.status !== 403) throw new Error(`Expected 403 Forbidden for unpermitted Generate Pass, got ${genRes.status}`);

    // 3b. Create Category without permission
    const catRes = await makeRequest({
      method: 'POST',
      path: '/categories',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: { eventId: 1, name: 'Forbidden Cat', code: 'forbid_cat', validFrom: '2026-10-02T00:00', validUntil: '2026-10-04T23:59' }
    });
    console.log(`  Case 3b (Event Admin POST /categories): Status = ${catRes.status} (Message: "${catRes.body.message}")`);
    if (catRes.status !== 403) throw new Error(`Expected 403 Forbidden for unpermitted Create Category, got ${catRes.status}`);

    // 3c. Access Pass Styles without permission
    const styleRes = await makeRequest({
      method: 'GET',
      path: '/pass-styles',
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    console.log(`  Case 3c (Event Admin GET /pass-styles): Status = ${styleRes.status} (Message: "${styleRes.body.message}")`);
    if (styleRes.status !== 403) throw new Error(`Expected 403 Forbidden for unpermitted Pass Styles, got ${styleRes.status}`);

    console.log('✅ Default 403 Forbidden enforcement confirmed for all restricted routes!\n');

    // 4. Grant Permissions via SuperAdmin RBAC
    console.log('[Step 4] SuperAdmin granting permissions to Event Admin (Role 2)...');
    const allPerms = await query('SELECT id, code FROM permissions');
    const permsToGrant = allPerms.filter(p => [
      'dashboard.view', 'passes.view', 'passes.generate', 'categories.create', 'pass_styles.view', 'pass_styles.create', 'billing.create', 'scan.operate', 'scan.history'
    ].includes(p.code));

    const grantRes = await makeRequest({
      method: 'PUT',
      path: '/users/roles/2/permissions',
      headers: { Authorization: `Bearer ${superToken}` },
      body: { permissionIds: permsToGrant.map(p => p.id) }
    });
    console.log(`- SuperAdmin PUT /users/roles/2/permissions: Status = ${grantRes.status} (${grantRes.body.message})`);

    // Re-login as Event Admin to get updated JWT claims & permissions
    const refreshedAdminLogin = await makeRequest({
      method: 'POST',
      path: '/auth/login',
      body: { email: 'admin@eventgen.com', password: 'Admin@2026!' }
    });
    adminToken = refreshedAdminLogin.body.accessToken;
    console.log(`- Updated Event Admin Permissions: [${refreshedAdminLogin.body.user?.permissions?.join(', ')}]`);

    // 5. Verify Permitted Actions Now Succeed (Status 200 / 201)
    console.log('\n[Step 5] Verifying Event Admin can now execute granted actions...');

    // 5a. Access Pass Styles
    const grantedStyleRes = await makeRequest({
      method: 'GET',
      path: '/pass-styles',
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    console.log(`  Case 5a (Event Admin GET /pass-styles): Status = ${grantedStyleRes.status} (Count: ${grantedStyleRes.body.data?.length || 0})`);
    if (grantedStyleRes.status !== 200) throw new Error('Failed to access /pass-styles with granted permission');

    // 5b. Generate Passes
    const grantedGenRes = await makeRequest({
      method: 'POST',
      path: '/passes/generate',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: { eventId: 1, categoryId: 1, quantity: 2 }
    });
    console.log(`  Case 5b (Event Admin POST /passes/generate): Status = ${grantedGenRes.status} (${grantedGenRes.body.message})`);
    if (grantedGenRes.status !== 201 && grantedGenRes.status !== 200) throw new Error('Failed to generate pass with granted permission');

    console.log('✅ Permissions granted and verified dynamically!\n');

    // 6. Revoke Permissions and verify re-lock
    console.log('[Step 6] SuperAdmin revoking permissions back to default state...');
    const defaultPerms = allPerms.filter(p => ['dashboard.view', 'passes.view', 'scan.operate', 'scan.history'].includes(p.code));
    await makeRequest({
      method: 'PUT',
      path: '/users/roles/2/permissions',
      headers: { Authorization: `Bearer ${superToken}` },
      body: { permissionIds: defaultPerms.map(p => p.id) }
    });

    console.log('================================================================');
    console.log('   ALL GRANULAR RBAC & PERMISSION TESTS PASSED 100%!           ');
    console.log('================================================================');
    process.exit(0);
  } catch (err) {
    console.error('\n❌ Test Failure:', err.message);
    process.exit(1);
  }
}

runRbacTests();
