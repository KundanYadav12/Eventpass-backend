/**
 * Automated Verification Test for Public Non-Sequential Download Tokens & WhatsApp Flow
 */
const http = require('http');

const PORT = 5006;
const HOST = 'localhost';

function request(options, data = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: HOST,
        port: PORT,
        path: options.path,
        method: options.method || 'GET',
        headers: {
          ...(data ? { 'Content-Type': 'application/json' } : {}),
          ...(options.headers || {})
        }
      },
      (res) => {
        const isPdf = res.headers['content-type']?.includes('application/pdf');
        let chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const bodyBuffer = Buffer.concat(chunks);
          if (isPdf) {
            resolve({
              status: res.statusCode,
              headers: res.headers,
              isPdf: true,
              size: bodyBuffer.length
            });
          } else {
            const bodyStr = bodyBuffer.toString('utf8');
            try {
              resolve({
                status: res.statusCode,
                headers: res.headers,
                data: bodyStr ? JSON.parse(bodyStr) : {}
              });
            } catch (e) {
              resolve({ status: res.statusCode, raw: bodyStr });
            }
          }
        });
      }
    );
    req.on('error', reject);
    if (data) {
      req.write(typeof data === 'string' ? data : JSON.stringify(data));
    }
    req.end();
  });
}

async function runTests() {
  console.log('================================================================');
  console.log('   SECURE NON-SEQUENTIAL DOWNLOAD TOKEN & WHATSAPP TEST SUITE   ');
  console.log('================================================================\n');

  // [Step 1] Authenticate SuperAdmin
  console.log('[Step 1] Authenticating Admin...');
  const loginRes = await request(
    { path: '/api/auth/login', method: 'POST' },
    { email: 'superadmin@eventgen.com', password: 'SuperAdmin@2026!' }
  );
  if (!loginRes.data.success) {
    throw new Error('Admin login failed');
  }
  const token = loginRes.data.accessToken;
  console.log('✅ Admin Authenticated.\n');

  // [Step 2] Issue a Customer Pass with WhatsApp Delivery
  console.log('[Step 2] Issuing Customer Pass with WhatsApp Delivery on Event 2...');
  const issueRes = await request(
    {
      path: '/api/billing/issue-and-send',
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` }
    },
    {
      eventId: 2,
      categoryId: 5,
      customerName: 'Aarav Patel',
      customerEmail: 'aarav.patel@example.com',
      customerPhone: '+91 98765 43210',
      quantity: 1,
      unitPrice: 499.00,
      gstMode: 'INCLUDED',
      gstRate: 18,
      sendVia: 'WHATSAPP'
    }
  );

  console.log('- Billing Status:', issueRes.status);
  console.log('- Invoice Number:', issueRes.data.billing?.bill_number);
  const downloadToken = issueRes.data.billing?.download_token;
  console.log('- Generated Non-Sequential Download Token:', downloadToken);
  console.log('- WhatsApp Message URL:', issueRes.data.whatsappUrl ? 'Generated' : 'None');

  if (!downloadToken || downloadToken.length < 8) {
    throw new Error('Failure: download_token was not generated or too short!');
  }
  if (!issueRes.data.whatsappUrl) {
    throw new Error('Failure: whatsappUrl was not generated!');
  }

  const decodedWaUrl = decodeURIComponent(issueRes.data.whatsappUrl);
  console.log('\n- Decoded WhatsApp Message Preview:\n---\n' + decodedWaUrl + '\n---\n');

  if (decodedWaUrl.includes('/api/billing/' + issueRes.data.billing.id + '/download-pass')) {
    throw new Error('Security Violation: Sequential database ID is exposed in WhatsApp link!');
  }
  if (!decodedWaUrl.includes(downloadToken)) {
    throw new Error('Failure: WhatsApp link does not contain the secure downloadToken!');
  }
  console.log('✅ Non-sequential secure download token generated and used in WhatsApp message!\n');

  // [Step 3] Customer downloads Pass PDF via Public Endpoint (NO AUTH TOKEN)
  console.log('[Step 3] Testing Public Pass PDF Download (No Login Required)...');
  const passDownloadRes = await request({
    path: `/api/public/download/pass/${downloadToken}`,
    method: 'GET'
  });
  console.log('- Pass Download Status:', passDownloadRes.status);
  console.log('- Content-Type:', passDownloadRes.headers['content-type']);
  console.log('- Content-Disposition:', passDownloadRes.headers['content-disposition']);
  console.log('- PDF Byte Size:', passDownloadRes.size, 'bytes');

  if (passDownloadRes.status !== 200 || !passDownloadRes.isPdf || passDownloadRes.size < 500) {
    throw new Error('Public Pass PDF download failed!');
  }
  console.log('✅ Public Pass PDF streamed successfully to customer mobile browser!\n');

  // [Step 4] Customer downloads Bill / Invoice PDF via Public Endpoint (NO AUTH TOKEN)
  console.log('[Step 4] Testing Public Invoice PDF Download (No Login Required)...');
  const billDownloadRes = await request({
    path: `/api/public/download/bill/${downloadToken}`,
    method: 'GET'
  });
  console.log('- Bill Download Status:', billDownloadRes.status);
  console.log('- Content-Type:', billDownloadRes.headers['content-type']);
  console.log('- Content-Disposition:', billDownloadRes.headers['content-disposition']);
  console.log('- PDF Byte Size:', billDownloadRes.size, 'bytes');

  if (billDownloadRes.status !== 200 || !billDownloadRes.isPdf || billDownloadRes.size < 500) {
    throw new Error('Public Invoice PDF download failed!');
  }
  console.log('✅ Public Tax Invoice PDF streamed successfully to customer mobile browser!\n');

  // [Step 5] Security Test: Tampered / Guessed Token Rejection
  console.log('[Step 5] Testing Tampered Token Rejection (Anti-IDOR Protection)...');
  const tamperedToken = downloadToken.substring(0, downloadToken.length - 2) + '99';
  const tamperedRes = await request({
    path: `/api/public/download/pass/${tamperedToken}`,
    method: 'GET'
  });
  console.log('- Tampered Token Status:', tamperedRes.status);
  console.log('- Tampered Token Response:', tamperedRes.data);

  if (tamperedRes.status !== 404 || tamperedRes.data.success !== false) {
    throw new Error('Security Failure: Tampered token was not rejected with 404!');
  }
  console.log('✅ Anti-IDOR Security Verified: Tampered / guessed tokens are strictly rejected with 404!\n');

  console.log('================================================================');
  console.log('   ALL PUBLIC DOWNLOAD TOKEN & WHATSAPP TESTS PASSED 100%!     ');
  console.log('================================================================\n');
}

runTests().catch((err) => {
  console.error('\n❌ Test Suite Failed:', err.message);
  process.exit(1);
});
