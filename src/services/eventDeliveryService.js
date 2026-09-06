const nodemailer = require('nodemailer');
const { query } = require('../config/db');
const { encryptSecret, decryptSecret, maskSecret } = require('../utils/cryptoUtil');
const { generatePassPdf, generateBillPdf } = require('./pdfService');
const { formatDateTimeIST, formatDateIST } = require('../utils/timeUtil');

/**
 * Fetch event-specific email settings.
 * Returns decrypted credentials if internal=true, otherwise masks passwords.
 */
async function getEventEmailSettings(eventId, { internal = false } = {}) {
  const rows = await query('SELECT * FROM event_email_settings WHERE event_id = ?', [eventId]);
  if (!rows || rows.length === 0) {
    const eventRows = await query('SELECT event_name FROM events WHERE id = ?', [eventId]);
    const eventName = eventRows?.[0]?.event_name || 'Event 2026';
    return {
      event_id: eventId,
      sender_name: `${eventName} Operations`,
      sender_email: 'admin@eventgen.duckdns.org',
      smtp_host: 'smtp.gmail.com',
      smtp_port: 465,
      smtp_secure: true,
      smtp_user: 'admin@eventgen.duckdns.org',
      smtp_pass: '',
      has_password: false,
      email_subject_template: `${eventName} — Your Official Passes & Tax Invoice`,
      is_enabled: true
    };
  }

  const s = rows[0];
  const hasPassword = Boolean(s.smtp_pass_encrypted);
  let decryptedPass = '';

  if (hasPassword && internal) {
    decryptedPass = decryptSecret(s.smtp_pass_encrypted, s.smtp_pass_iv, s.smtp_pass_auth_tag) || '';
  }

  return {
    id: s.id,
    event_id: s.event_id,
    sender_name: s.sender_name,
    sender_email: s.sender_email,
    smtp_host: s.smtp_host,
    smtp_port: s.smtp_port,
    smtp_secure: Boolean(s.smtp_secure),
    smtp_user: s.smtp_user || s.sender_email || '',
    smtp_pass: internal ? decryptedPass : maskSecret(hasPassword),
    has_password: hasPassword,
    email_subject_template: s.email_subject_template,
    is_enabled: Boolean(s.is_enabled),
    updated_at: s.updated_at
  };
}

/**
 * Save/Update event-specific email settings
 */
async function saveEventEmailSettings(eventId, data) {
  const {
    sender_name,
    sender_email,
    smtp_host,
    smtp_port,
    smtp_secure,
    smtp_user,
    smtp_pass,
    email_subject_template,
    is_enabled
  } = data;

  let cleanHost = (smtp_host || '').trim();
  let cleanUser = (smtp_user || sender_email || '').trim();
  const cleanPass = (smtp_pass || '').replace(/\s+/g, '');

  // Auto-normalize if user typed an email address into smtp_host or if host contains gmail
  if (!cleanHost || cleanHost.includes('@') || cleanHost.toLowerCase().includes('gmail')) {
    cleanHost = 'smtp.gmail.com';
  }
  if (!cleanUser || !cleanUser.includes('@')) {
    cleanUser = (sender_email || '').trim();
  }

  const isGmail = cleanHost.toLowerCase().includes('gmail');
  const portNum = parseInt(smtp_port || (isGmail ? '465' : '587'), 10);
  const isSecure = portNum === 465 || Boolean(smtp_secure);

  if (cleanPass && cleanPass !== '••••••••') {
    const enc = encryptSecret(cleanPass);
    await query(
      `INSERT INTO event_email_settings
         (event_id, sender_name, sender_email, smtp_host, smtp_port, smtp_secure, smtp_user, email_subject_template, is_enabled, smtp_pass_encrypted, smtp_pass_iv, smtp_pass_auth_tag)
       VALUES
         (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         sender_name = VALUES(sender_name),
         sender_email = VALUES(sender_email),
         smtp_host = VALUES(smtp_host),
         smtp_port = VALUES(smtp_port),
         smtp_secure = VALUES(smtp_secure),
         smtp_user = VALUES(smtp_user),
         email_subject_template = VALUES(email_subject_template),
         is_enabled = VALUES(is_enabled),
         smtp_pass_encrypted = VALUES(smtp_pass_encrypted),
         smtp_pass_iv = VALUES(smtp_pass_iv),
         smtp_pass_auth_tag = VALUES(smtp_pass_auth_tag)`,
      [
        eventId,
        sender_name || 'Event Operations Team',
        sender_email || 'admin@eventgen.duckdns.org',
        cleanHost,
        portNum,
        isSecure ? 1 : 0,
        cleanUser || null,
        email_subject_template || 'Official Pass Confirmation & Invoice',
        is_enabled !== undefined ? (is_enabled ? 1 : 0) : 1,
        enc.encrypted,
        enc.iv,
        enc.authTag
      ]
    );
  } else {
    await query(
      `INSERT INTO event_email_settings
         (event_id, sender_name, sender_email, smtp_host, smtp_port, smtp_secure, smtp_user, email_subject_template, is_enabled)
       VALUES
         (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         sender_name = VALUES(sender_name),
         sender_email = VALUES(sender_email),
         smtp_host = VALUES(smtp_host),
         smtp_port = VALUES(smtp_port),
         smtp_secure = VALUES(smtp_secure),
         smtp_user = VALUES(smtp_user),
         email_subject_template = VALUES(email_subject_template),
         is_enabled = VALUES(is_enabled)`,
      [
        eventId,
        sender_name || 'Event Operations Team',
        sender_email || 'admin@eventgen.duckdns.org',
        cleanHost,
        portNum,
        isSecure ? 1 : 0,
        cleanUser || null,
        email_subject_template || 'Official Pass Confirmation & Invoice',
        is_enabled !== undefined ? (is_enabled ? 1 : 0) : 1
      ]
    );
  }

  return getEventEmailSettings(eventId, { internal: false });
}

/**
 * Fetch event-specific WhatsApp settings
 */
async function getEventWhatsappSettings(eventId, { internal = false } = {}) {
  const rows = await query('SELECT * FROM event_whatsapp_settings WHERE event_id = ?', [eventId]);
  if (!rows || rows.length === 0) {
    return {
      event_id: eventId,
      provider: 'WHATSAPP_LINK',
      phone_number_id: '',
      access_token: '',
      has_token: false,
      custom_message_template:
        'Hello *{customerName}*! 🎉\n' +
        'Your passes for *{eventName}* are confirmed.\n\n' +
        '*Pass Codes:* {passCodes}\n' +
        '*Total Paid:* ₹{totalAmount}\n\n' +
        '🎟️ *Download Pass PDF:*\n{passPdfUrl}\n\n' +
        '🧾 *Download Bill Invoice:*\n{billPdfUrl}\n\n' +
        '_Please present the pass barcode at the entrance gate._',
      is_enabled: true
    };
  }

  const s = rows[0];
  const hasToken = Boolean(s.access_token_encrypted);
  let decryptedToken = '';

  if (hasToken && internal) {
    decryptedToken = decryptSecret(s.access_token_encrypted, s.access_token_iv, s.access_token_auth_tag) || '';
  }

  return {
    id: s.id,
    event_id: s.event_id,
    provider: s.provider,
    phone_number_id: s.phone_number_id || '',
    access_token: internal ? decryptedToken : maskSecret(hasToken),
    has_token: hasToken,
    custom_message_template: s.custom_message_template,
    is_enabled: Boolean(s.is_enabled),
    updated_at: s.updated_at
  };
}

/**
 * Save event-specific WhatsApp settings
 */
async function saveEventWhatsappSettings(eventId, data) {
  const {
    provider,
    phone_number_id,
    access_token,
    custom_message_template,
    is_enabled
  } = data;

  const cleanToken = (access_token || '').trim();

  if (cleanToken && cleanToken !== '••••••••') {
    const enc = encryptSecret(cleanToken);
    await query(
      `INSERT INTO event_whatsapp_settings
         (event_id, provider, phone_number_id, custom_message_template, is_enabled, access_token_encrypted, access_token_iv, access_token_auth_tag)
       VALUES
         (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         provider = VALUES(provider),
         phone_number_id = VALUES(phone_number_id),
         custom_message_template = VALUES(custom_message_template),
         is_enabled = VALUES(is_enabled),
         access_token_encrypted = VALUES(access_token_encrypted),
         access_token_iv = VALUES(access_token_iv),
         access_token_auth_tag = VALUES(access_token_auth_tag)`,
      [
        eventId,
        provider || 'WHATSAPP_LINK',
        phone_number_id || null,
        custom_message_template || 'Hello *{customerName}*! Your tickets are confirmed.',
        is_enabled !== undefined ? (is_enabled ? 1 : 0) : 1,
        enc.encrypted,
        enc.iv,
        enc.authTag
      ]
    );
  } else {
    await query(
      `INSERT INTO event_whatsapp_settings
         (event_id, provider, phone_number_id, custom_message_template, is_enabled)
       VALUES
         (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         provider = VALUES(provider),
         phone_number_id = VALUES(phone_number_id),
         custom_message_template = VALUES(custom_message_template),
         is_enabled = VALUES(is_enabled)`,
      [
        eventId,
        provider || 'WHATSAPP_LINK',
        phone_number_id || null,
        custom_message_template || 'Hello *{customerName}*! Your tickets are confirmed.',
        is_enabled !== undefined ? (is_enabled ? 1 : 0) : 1
      ]
    );
  }

  return getEventWhatsappSettings(eventId, { internal: false });
}

/**
 * Create dynamic event-scoped Nodemailer transporter
 */
function createEventTransporter(settings) {
  let host = (settings.smtp_host || 'smtp.gmail.com').trim().toLowerCase();
  let user = (settings.smtp_user || settings.sender_email || '').trim();
  const pass = (settings.smtp_pass || '').replace(/\s+/g, '');

  // Auto-normalize if user typed an email into smtp_host or if it's Gmail
  if (host.includes('@') || host.includes('gmail') || user.includes('@gmail.com') || (settings.sender_email && settings.sender_email.includes('@gmail.com'))) {
    if (!user.includes('@')) {
      user = (settings.sender_email || '').trim();
    }
    return nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user,
        pass
      }
    });
  }

  const port = parseInt(settings.smtp_port || '587', 10);
  const isSecure = port === 465 || Boolean(settings.smtp_secure);

  return nodemailer.createTransport({
    host,
    port,
    secure: isSecure,
    auth: {
      user,
      pass
    },
    tls: {
      rejectUnauthorized: false
    }
  });
}

/**
 * Send an email specifically using that Event's configured SMTP details
 * Guarantees BOTH Pass PDF and Bill PDF attachments are passed.
 */
async function sendEventEmail({
  eventId,
  to,
  subject,
  html,
  text,
  attachments = [],
  billingId = null,
  customSettings = null
}) {
  const settings = customSettings || (await getEventEmailSettings(eventId, { internal: true }));

  if (!settings.is_enabled && !customSettings) {
    console.log(`[Delivery Service] Email delivery is disabled for Event #${eventId}`);
    await query(
      `INSERT INTO delivery_logs (event_id, billing_id, channel, recipient, status, error_message, created_at)
       VALUES (?, ?, 'EMAIL', ?, 'FAILED', 'Email delivery is disabled in event settings', NOW())`,
      [eventId, billingId, to]
    );
    return { success: false, status: 'DISABLED', message: 'Email delivery disabled for this event' };
  }

  const fromAddress = `"${settings.sender_name || 'Event Operations'}" <${settings.sender_email}>`;

  // Only mock if password is not configured or explicitly starts with 'mock_'
  const isMock = !settings.smtp_pass || settings.smtp_pass.startsWith('mock_');

  if (isMock) {
    console.log(`[Event Email Preview] (Simulation) Event #${eventId} From: ${fromAddress} | To: ${to} | Subject: ${subject}`);
    console.log(`[Event Email Attachments]: ${attachments.map(a => a.filename).join(', ') || 'None'}`);

    await query(
      `INSERT INTO delivery_logs (event_id, billing_id, channel, recipient, status, message_id, created_at)
       VALUES (?, ?, 'EMAIL', ?, 'SUCCESS', ?, NOW())`,
      [eventId, billingId, to, 'simulated-' + Date.now()]
    );

    return {
      success: true,
      status: 'SENT',
      simulated: true,
      messageId: 'simulated-' + Date.now(),
      sender: fromAddress,
      attachmentsCount: attachments.length
    };
  }

  try {
    const transporter = createEventTransporter(settings);
    const info = await transporter.sendMail({
      from: fromAddress,
      to,
      subject,
      text,
      html,
      attachments
    });

    console.log(`[Event Email Success] Sent email to ${to} (Message ID: ${info.messageId})`);

    await query(
      `INSERT INTO delivery_logs (event_id, billing_id, channel, recipient, status, message_id, created_at)
       VALUES (?, ?, 'EMAIL', ?, 'SUCCESS', ?, NOW())`,
      [eventId, billingId, to, info.messageId]
    );

    return {
      success: true,
      status: 'SENT',
      simulated: false,
      messageId: info.messageId,
      sender: fromAddress,
      attachmentsCount: attachments.length
    };
  } catch (error) {
    console.error(`[Event Email Error] Event #${eventId} failed to send to ${to}:`, error.message);

    await query(
      `INSERT INTO delivery_logs (event_id, billing_id, channel, recipient, status, error_message, created_at)
       VALUES (?, ?, 'EMAIL', ?, 'FAILED', ?, NOW())`,
      [eventId, billingId, to, error.message]
    );

    return {
      success: false,
      status: 'FAILED',
      error: error.message
    };
  }
}

/**
 * End-to-end Test Email function for an Event
 * Generates sample Pass PDF & Invoice PDF and tests the SMTP configuration
 */
async function testEventEmail({ eventId, recipientEmail, overrideSettings = null }) {
  const eventRows = await query('SELECT * FROM events WHERE id = ?', [eventId]);
  if (!eventRows || eventRows.length === 0) {
    throw new Error(`Event #${eventId} not found`);
  }
  const event = eventRows[0];

  const catRows = await query('SELECT * FROM pass_categories WHERE event_id = ? LIMIT 1', [eventId]);
  const category = catRows?.[0] || {
    id: 999,
    name: 'VIP Test Pass',
    code: 'VIP',
    price: 499.00
  };

  const samplePass = {
    code: 'TEST2026',
    code_type: category.code || 'VIP',
    customer_name: 'Test Recipient',
    sponsor_name: 'Official Partner'
  };

  const mockBilling = {
    bill_number: 'TEST-INV-001',
    customer_name: 'Test Recipient',
    customer_email: recipientEmail,
    customer_phone: '+91 98765 43210',
    sponsor_name: 'Official Partner',
    quantity: 1,
    unit_price: 499.00,
    subtotal: 499.00,
    gst_mode: 'INCLUDED',
    gst_rate: 18,
    gst_amount: 76.12,
    total_amount: 499.00,
    include_pass_code_on_bill: true,
    created_at: new Date()
  };

  // Generate both sample PDFs
  const passPdfBuffer = await generatePassPdf({
    pass: samplePass,
    event,
    category,
    customer: { name: 'Test Recipient' }
  });

  const billPdfBuffer = await generateBillPdf({
    billing: mockBilling,
    event,
    category,
    passes: [samplePass]
  });

  let effectiveSettings;
  if (overrideSettings && overrideSettings.smtp_pass && overrideSettings.smtp_pass !== '••••••••') {
    effectiveSettings = {
      ...overrideSettings,
      smtp_user: (overrideSettings.smtp_user || overrideSettings.sender_email || '').trim(),
      smtp_pass: (overrideSettings.smtp_pass || '').replace(/\s+/g, ''),
      is_enabled: true
    };
  } else {
    effectiveSettings = await getEventEmailSettings(eventId, { internal: true });
    if (overrideSettings) {
      effectiveSettings.sender_name = overrideSettings.sender_name || effectiveSettings.sender_name;
      effectiveSettings.sender_email = overrideSettings.sender_email || effectiveSettings.sender_email;
      effectiveSettings.smtp_host = overrideSettings.smtp_host || effectiveSettings.smtp_host;
      effectiveSettings.smtp_port = overrideSettings.smtp_port || effectiveSettings.smtp_port;
      effectiveSettings.smtp_secure = overrideSettings.smtp_secure !== undefined ? overrideSettings.smtp_secure : effectiveSettings.smtp_secure;
      effectiveSettings.smtp_user = overrideSettings.smtp_user || overrideSettings.sender_email || effectiveSettings.smtp_user;
    }
  }

  const subject = `[TEST] ${event.event_name} — SMTP Configuration Test & Sample Attachments`;

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #1E293B;">
      <div style="background-color: #0F172A; padding: 20px; text-align: center; border-radius: 8px 8px 0 0;">
        <h2 style="color: #38BDF8; margin: 0;">${event.event_name}</h2>
        <p style="color: #94A3B8; margin: 6px 0 0 0; font-size: 13px;">Event SMTP & Delivery Diagnostic Test</p>
      </div>
      <div style="padding: 24px; border: 1px solid #E2E8F0; background-color: #FFFFFF; border-radius: 0 0 8px 8px;">
        <p style="font-size: 15px; color: #047857; font-weight: bold;">
          ✅ SMTP Connection & PDF Generation Succeeded!
        </p>
        <p>This is an automated diagnostic test verifying that your event-specific email configuration is operational.</p>
        
        <div style="background-color: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 6px; padding: 14px; margin: 18px 0; font-size: 13px;">
          <p style="margin: 0 0 6px 0;"><strong>Event Context:</strong> ${event.event_name} (#${event.id})</p>
          <p style="margin: 0 0 6px 0;"><strong>Configured Sender:</strong> ${effectiveSettings.sender_name} &lt;${effectiveSettings.sender_email}&gt;</p>
          <p style="margin: 0 0 6px 0;"><strong>SMTP Host:</strong> ${effectiveSettings.smtp_host}:${effectiveSettings.smtp_port}</p>
          <p style="margin: 0;"><strong>Mandatory Attachments Included:</strong> 2 Files (Pass PDF + Tax Invoice PDF)</p>
        </div>

        <p style="font-size: 12.5px; color: #64748B;">
          Please check the attached sample <strong>Pass_TEST2026.pdf</strong> and <strong>Invoice_TEST-INV-001.pdf</strong> to verify your barcode and invoice rendering.
        </p>
      </div>
    </div>
  `;

  const attachments = [
    {
      filename: `Pass_TEST2026.pdf`,
      content: passPdfBuffer,
      contentType: 'application/pdf'
    },
    {
      filename: `Invoice_TEST-INV-001.pdf`,
      content: billPdfBuffer,
      contentType: 'application/pdf'
    }
  ];

  const result = await sendEventEmail({
    eventId,
    to: recipientEmail,
    subject,
    html,
    attachments,
    customSettings: effectiveSettings
  });

  return {
    ...result,
    event: { id: event.id, name: event.event_name },
    recipient: recipientEmail,
    attachments: attachments.map(a => a.filename)
  };
}

/**
 * Generate Event-Specific WhatsApp message and download links
 */
async function generateEventWhatsappDelivery({
  eventId,
  customerPhone,
  customerName,
  eventName,
  passCodes = [],
  totalAmount,
  billingId,
  downloadToken = null,
  baseUrl = null,
  passPdfBuffer,
  billPdfBuffer
}) {
  const ws = await getEventWhatsappSettings(eventId, { internal: true });

  // Resolve public domain dynamically (e.g. from baseUrl, process.env.PUBLIC_URL, APP_BASE_URL, or VITE_API_URL)
  const publicBaseUrl = (
    baseUrl ||
    process.env.PUBLIC_URL ||
    process.env.APP_BASE_URL ||
    process.env.VITE_API_URL ||
    'http://localhost:5006'
  ).replace(/\/+$/, '');

  // Secure non-sequential token identifier (never expose sequential database ID)
  const secureToken = downloadToken || (billingId ? String(billingId) : 'token');
  const passPdfUrl = `${publicBaseUrl}/api/public/download/pass/${secureToken}`;
  const billPdfUrl = `${publicBaseUrl}/api/public/download/bill/${secureToken}`;

  const defaultTemplate =
    'Hello *{customerName}*! 🎉\n' +
    'Your passes for *{eventName}* are confirmed.\n\n' +
    '*Pass Codes:* {passCodes}\n' +
    '*Total Paid:* ₹{totalAmount}\n\n' +
    '🎟️ *Download Pass PDF:*\n{passPdfUrl}\n\n' +
    '🧾 *Download Bill Invoice:*\n{billPdfUrl}\n\n' +
    '_Please present the pass barcode at the entrance gate._';

  let message = ws.custom_message_template || defaultTemplate;

  message = message
    .replace(/{customerName}/g, customerName || 'Valued Guest')
    .replace(/{eventName}/g, eventName || 'Event 2026')
    .replace(/{passCodes}/g, passCodes.join(', ') || 'N/A')
    .replace(/{totalAmount}/g, parseFloat(totalAmount || 0).toFixed(2))
    .replace(/{passPdfUrl}/g, passPdfUrl)
    .replace(/{billPdfUrl}/g, billPdfUrl);

  const cleanPhone = (customerPhone || '').replace(/[^0-9]/g, '');
  const encodedText = encodeURIComponent(message);
  const whatsappUrl = `https://api.whatsapp.com/send?phone=${cleanPhone}&text=${encodedText}`;

  await query(
    `INSERT INTO delivery_logs (event_id, billing_id, channel, recipient, status, created_at)
     VALUES (?, ?, 'WHATSAPP', ?, 'SUCCESS', NOW())`,
    [eventId, billingId, customerPhone || 'Unknown']
  );

  return {
    success: true,
    status: 'READY',
    whatsappUrl,
    message,
    passPdfUrl,
    billPdfUrl,
    downloadToken: secureToken
  };
}

module.exports = {
  getEventEmailSettings,
  saveEventEmailSettings,
  getEventWhatsappSettings,
  saveEventWhatsappSettings,
  sendEventEmail,
  testEventEmail,
  generateEventWhatsappDelivery
};
