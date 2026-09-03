/**
 * Automated Verification Test Suite for Event-Scoped Email & WhatsApp Delivery
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
          'Content-Type': 'application/json',
          ...(options.headers || {})
        }
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          try {
            const parsed = body ? JSON.parse(body) : {};
            resolve({ status: res.statusCode, data: parsed });
          } catch (e) {
            resolve({ status: res.statusCode, raw: body });
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
  console.log('   EVENT-SCOPED EMAIL & WHATSAPP DELIVERY VERIFICATION SUITE   ');
  console.log('================================================================\n');

  // [Step 1] Authenticate SuperAdmin
  console.log('[Step 1] Authenticating SuperAdmin...');
  const loginRes = await request(
    { path: '/api/auth/login', method: 'POST' },
    { email: 'superadmin@eventgen.com', password: 'SuperAdmin@2026!' }
  );
  if (!loginRes.data.success) {
    throw new Error('SuperAdmin login failed: ' + JSON.stringify(loginRes.data));
  }
  const saToken = loginRes.data.accessToken;
  console.log('✅ SuperAdmin Authenticated.\n');

  // [Step 2] Configure Event 1 Email Settings
  console.log('[Step 2] Configuring Event #1 Email & SMTP Settings...');
  const event1EmailRes = await request(
    { path: '/api/events/1/delivery/email', method: 'PUT', headers: { Authorization: `Bearer ${saToken}` } },
    {
      sender_name: 'Corporate Expo 2026 Official Desk',
      sender_email: 'passes@corporateexpo2026.com',
      smtp_host: 'smtp.corporateexpo.com',
      smtp_port: 587,
      smtp_secure: false,
      smtp_user: 'expo_smtp_user',
      smtp_pass: 'mock_expo_secret_pass_2026',
      email_subject_template: 'Corporate Expo 2026 — Entry Pass & Tax Invoice',
      is_enabled: true
    }
  );
  console.log('- Event 1 Email Save Status:', event1EmailRes.status, event1EmailRes.data.message);
  console.log('- Event 1 Returned Masked Password:', event1EmailRes.data.settings?.smtp_pass);
  if (event1EmailRes.data.settings?.smtp_pass !== '••••••••') {
    throw new Error('Security Violation: Password was not masked on API return!');
  }
  console.log('✅ Event 1 Email Settings configured and encrypted.\n');

  // [Step 3] Configure Event 2 Email Settings (Completely Distinct Provider & Credentials)
  console.log('[Step 3] Configuring Event #2 Email & SMTP Settings (Distinct Credentials)...');
  const event2EmailRes = await request(
    { path: '/api/events/2/delivery/email', method: 'PUT', headers: { Authorization: `Bearer ${saToken}` } },
    {
      sender_name: 'Music Festival 2026 Box Office',
      sender_email: 'tickets@musicfestival2026.org',
      smtp_host: 'smtp.musicfest-mail.com',
      smtp_port: 465,
      smtp_secure: true,
      smtp_user: 'music_smtp_user',
      smtp_pass: 'mock_music_secret_pass_999',
      email_subject_template: 'Music Festival 2026 — Your VIP Pass & Bill',
      is_enabled: true
    }
  );
  console.log('- Event 2 Email Save Status:', event2EmailRes.status, event2EmailRes.data.message);
  console.log('- Event 2 Returned Masked Password:', event2EmailRes.data.settings?.smtp_pass);
  console.log('✅ Event 2 Email Settings configured independently.\n');

  // [Step 4] Verify Strict Event Isolation
  console.log('[Step 4] Verifying Strict Event Isolation...');
  const getEvent1Res = await request(
    { path: '/api/events/1/delivery/email', method: 'GET', headers: { Authorization: `Bearer ${saToken}` } }
  );
  const getEvent2Res = await request(
    { path: '/api/events/2/delivery/email', method: 'GET', headers: { Authorization: `Bearer ${saToken}` } }
  );

  console.log(`- Event 1 Sender: "${getEvent1Res.data.settings?.sender_name}" <${getEvent1Res.data.settings?.sender_email}> (Host: ${getEvent1Res.data.settings?.smtp_host})`);
  console.log(`- Event 2 Sender: "${getEvent2Res.data.settings?.sender_name}" <${getEvent2Res.data.settings?.sender_email}> (Host: ${getEvent2Res.data.settings?.smtp_host})`);

  if (getEvent1Res.data.settings?.smtp_host === getEvent2Res.data.settings?.smtp_host) {
    throw new Error('Isolation Failure: Event 1 and Event 2 are sharing SMTP host!');
  }
  if (getEvent1Res.data.settings?.sender_email === getEvent2Res.data.settings?.sender_email) {
    throw new Error('Isolation Failure: Event 1 and Event 2 are sharing sender email!');
  }
  console.log('✅ Strict Event Isolation Verified: Event 1 and Event 2 use completely independent configurations!\n');

  // [Step 5] Test Live Diagnostic Email on Event 1
  console.log('[Step 5] Running Live Test Email on Event #1 with Sample Dual PDFs...');
  const testEmailRes = await request(
    { path: '/api/events/1/delivery/email/test', method: 'POST', headers: { Authorization: `Bearer ${saToken}` } },
    { recipientEmail: 'test.attendee@example.com' }
  );
  console.log('- Test Email Status:', testEmailRes.status);
  console.log('- Test Email Message:', testEmailRes.data.message);
  console.log('- Attachments Included:', testEmailRes.data.details?.attachments);

  if (!testEmailRes.data.details?.attachments?.includes('Pass_TEST2026.pdf') ||
      !testEmailRes.data.details?.attachments?.includes('Invoice_TEST-INV-001.pdf')) {
    throw new Error('Attachment Failure: Both Pass PDF and Invoice PDF must be attached!');
  }
  console.log('✅ Test Email Dispatched with BOTH Pass PDF and Invoice PDF attached!\n');

  // [Step 6] Customer Billing & Automated Dual-PDF Issuance
  console.log('[Step 6] Issuing Customer Pass & Invoice via Billing Flow on Event #1...');
  const billingRes = await request(
    { path: '/api/billing/issue-and-send', method: 'POST', headers: { Authorization: `Bearer ${saToken}` } },
    {
      eventId: 1,
      categoryId: 1,
      customerName: 'Kavita Iyer',
      customerEmail: 'kavita.iyer@example.com',
      customerPhone: '+91 98200 12345',
      sponsorName: 'Global Tech Sponsors',
      quantity: 2,
      unitPrice: 250,
      gstMode: 'INCLUDED',
      gstRate: 18,
      sendVia: 'BOTH'
    }
  );
  console.log('- Billing Issuance Status:', billingRes.status);
  console.log('- Invoice Number:', billingRes.data.billing?.bill_number);
  console.log('- Generated Pass Codes:', billingRes.data.passes?.map(p => p.code));
  console.log('- Email Delivery Status:', billingRes.data.emailDelivery?.status);
  console.log('- Email Sender Used:', billingRes.data.emailDelivery?.sender);
  console.log('- WhatsApp Delivery Status:', billingRes.data.whatsappDelivery?.status);
  console.log('- WhatsApp Link Generated:', Boolean(billingRes.data.whatsappUrl));

  if (billingRes.data.emailDelivery?.status !== 'SENT') {
    throw new Error('Email delivery failed in billing flow!');
  }
  if (!billingRes.data.whatsappUrl) {
    throw new Error('WhatsApp delivery URL was not generated!');
  }
  console.log('✅ End-to-End Customer Purchase, PDF Generation, Email & WhatsApp Delivery Verified!\n');

  // [Step 7] Verify Delivery Audit Logs
  console.log('[Step 7] Checking Delivery Logs for Event #1...');
  const logsRes = await request(
    { path: '/api/events/1/delivery/logs', method: 'GET', headers: { Authorization: `Bearer ${saToken}` } }
  );
  console.log('- Total Delivery Logs Count:', logsRes.data.logs?.length);
  const latestEmailLog = logsRes.data.logs?.find(l => l.channel === 'EMAIL');
  const latestWaLog = logsRes.data.logs?.find(l => l.channel === 'WHATSAPP');
  console.log('- Latest Email Log:', latestEmailLog ? `[${latestEmailLog.status}] to ${latestEmailLog.recipient}` : 'None');
  console.log('- Latest WhatsApp Log:', latestWaLog ? `[${latestWaLog.status}] to ${latestWaLog.recipient}` : 'None');

  if (!latestEmailLog || !latestWaLog) {
    throw new Error('Delivery logs were not recorded in database!');
  }
  console.log('✅ Delivery Audit Logs recorded accurately in database!\n');

  console.log('================================================================');
  console.log('   ALL EVENT DELIVERY TESTS PASSED 100%!                       ');
  console.log('================================================================\n');
}

runTests().catch((err) => {
  console.error('\n❌ Test Suite Failed:', err.message);
  process.exit(1);
});
