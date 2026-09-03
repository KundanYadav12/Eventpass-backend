const { query, withTransaction } = require('../config/db');
const { generatePassCode, generateHmacSignature, generateSecureToken } = require('../utils/cryptoUtil');
const { logAudit } = require('./AuditService');
const { generatePassPdf, generateBillPdf } = require('./pdfService');
const eventDeliveryService = require('./eventDeliveryService');
const { formatDateTimeIST, formatDateIST } = require('../utils/timeUtil');

/**
 * Calculate GST amounts with high precision
 */
function calculateGst({ unitPrice, quantity = 1, gstMode = 'INCLUDED', gstRate = 18 }) {
  const qty = Math.max(1, parseInt(quantity, 10) || 1);
  const price = Math.max(0, parseFloat(unitPrice) || 0);
  const rate = Math.max(0, parseFloat(gstRate) || 18);
  const rawSubtotal = price * qty;

  let subtotal = rawSubtotal;
  let gstAmount = 0;
  let totalAmount = rawSubtotal;

  if (gstMode === 'INCLUDED') {
    // Price includes GST
    const base = rawSubtotal / (1 + rate / 100);
    subtotal = Math.round(base * 100) / 100;
    gstAmount = Math.round((rawSubtotal - subtotal) * 100) / 100;
    totalAmount = rawSubtotal;
  } else if (gstMode === 'EXCLUDED') {
    // GST added on top of base price
    subtotal = rawSubtotal;
    gstAmount = Math.round((rawSubtotal * (rate / 100)) * 100) / 100;
    totalAmount = Math.round((subtotal + gstAmount) * 100) / 100;
  } else {
    // GST OFF
    subtotal = rawSubtotal;
    gstAmount = 0;
    totalAmount = rawSubtotal;
  }

  return {
    unitPrice: price,
    quantity: qty,
    subtotal,
    gstMode,
    gstRate: rate,
    gstAmount,
    totalAmount
  };
}

/**
 * Issue passes for customer, generate Bill and Pass PDFs, and optionally dispatch via Email / WhatsApp
 */
async function issuePassesAndBill({
  eventId,
  categoryId,
  styleId = null,
  customerName,
  customerEmail = null,
  customerPhone = null,
  sponsorName = null,
  quantity = 1,
  unitPrice = null,
  gstMode = 'INCLUDED',
  gstRate = 18,
  includePassCodeOnBill = true,
  sendVia = 'NONE',
  senderName = '',
  senderEmail = '',
  emailSubject = '',
  userId = null,
  userName = '',
  ipAddress = null,
  userAgent = null,
  baseUrl = null
}) {
  if (!eventId || !categoryId || !customerName || !customerName.trim()) {
    throw new Error('Event, Category, and Customer Name are required');
  }

  // 1. Fetch Event, Category, and Pass Style
  const eventRows = await query('SELECT * FROM events WHERE id = ?', [eventId]);
  if (!eventRows || eventRows.length === 0) throw new Error('Event not found');
  const event = eventRows[0];

  const catRows = await query('SELECT * FROM pass_categories WHERE id = ?', [categoryId]);
  if (!catRows || catRows.length === 0) throw new Error('Pass Category not found');
  const category = catRows[0];

  let style = null;
  if (styleId) {
    const styleRows = await query('SELECT * FROM pass_styles WHERE id = ?', [styleId]);
    if (styleRows && styleRows.length > 0) style = styleRows[0];
  }

  // Fallback to default style for event or global default if none specified
  if (!style) {
    const defaultStyles = await query(
      'SELECT * FROM pass_styles WHERE (event_id = ? OR event_id IS NULL) ORDER BY is_default DESC, id ASC LIMIT 1',
      [eventId]
    );
    if (defaultStyles && defaultStyles.length > 0) style = defaultStyles[0];
  }

  // Determine pricing & calculate GST
  const finalUnitPrice = unitPrice !== null && unitPrice !== undefined ? parseFloat(unitPrice) : parseFloat(category.price || 0);
  const calc = calculateGst({
    unitPrice: finalUnitPrice,
    quantity,
    gstMode,
    gstRate
  });

  // 2. Perform Transactional Pass & Bill Creation
  const result = await withTransaction(async (conn) => {
    // Generate Invoice Number e.g. INV-2026-1001
    const [lastBill] = await conn.query('SELECT MAX(id) as max_id FROM billings');
    const nextNum = (lastBill[0]?.max_id || 0) + 1;
    const billNumber = `INV-${new Date().getFullYear()}-${String(nextNum).padStart(4, '0')}`;
    const downloadToken = generateSecureToken(16);

    const [billRes] = await conn.query(
      `INSERT INTO billings (
        bill_number, download_token, event_id, category_id, style_id, customer_name, customer_email,
        customer_phone, sponsor_name, quantity, unit_price, subtotal, gst_mode,
        gst_rate, gst_amount, total_amount, include_pass_code_on_bill, sent_via,
        created_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        billNumber,
        downloadToken,
        eventId,
        categoryId,
        style?.id || null,
        customerName.trim(),
        customerEmail ? customerEmail.trim().toLowerCase() : null,
        customerPhone ? customerPhone.trim() : null,
        sponsorName ? sponsorName.trim() : null,
        calc.quantity,
        calc.unitPrice,
        calc.subtotal,
        calc.gstMode,
        calc.gstRate,
        calc.gstAmount,
        calc.totalAmount,
        includePassCodeOnBill ? 1 : 0,
        sendVia,
        userId
      ]
    );

    const billingId = billRes.insertId;

    // Generate individual passes
    const createdPasses = [];
    for (let i = 0; i < calc.quantity; i++) {
      const code = generatePassCode();
      const hmac = generateHmacSignature(code);

      const [passRes] = await conn.query(
        `INSERT INTO passes (
          event_id, category_id, code, code_type, category_prefix, hmac_sig,
          status, valid_from, valid_until, printed, billing_id, style_id,
          customer_name, customer_email, customer_phone, sponsor_name, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, false, ?, ?, ?, ?, ?, ?, NOW())`,
        [
          eventId,
          categoryId,
          code,
          category.code,
          category.category_prefix || '',
          hmac,
          category.valid_from,
          category.valid_until,
          billingId,
          style?.id || null,
          customerName.trim(),
          customerEmail ? customerEmail.trim().toLowerCase() : null,
          customerPhone ? customerPhone.trim() : null,
          sponsorName ? sponsorName.trim() : null
        ]
      );

      createdPasses.push({
        id: passRes.insertId,
        code,
        hmac_sig: hmac,
        category_name: category.name,
        customer_name: customerName
      });
    }

    // Update Category total passes
    await conn.query('UPDATE pass_categories SET total_quantity = total_quantity + ? WHERE id = ?', [calc.quantity, categoryId]);

    // Audit Log
    await conn.query(
      `INSERT INTO audit_log (event_id, user_id, user_name, action, entity, entity_id, new_value, ip_address, user_agent, created_at)
       VALUES (?, ?, ?, 'CUSTOMER_BILLING_AND_PASS_ISSUE', 'BILLING', ?, ?, ?, ?, NOW())`,
      [
        eventId,
        userId,
        userName,
        String(billingId),
        JSON.stringify({
          billNumber,
          downloadToken,
          customerName,
          quantity: calc.quantity,
          totalAmount: calc.totalAmount,
          passCodes: createdPasses.map(p => p.code)
        }),
        ipAddress,
        userAgent
      ]
    );

    return {
      billingId,
      billNumber,
      downloadToken,
      createdPasses
    };
  });

  // 3. Generate PDFs
  const billingRecord = {
    id: result.billingId,
    bill_number: result.billNumber,
    customer_name: customerName,
    customer_email: customerEmail,
    customer_phone: customerPhone,
    sponsor_name: sponsorName,
    quantity: calc.quantity,
    unit_price: calc.unitPrice,
    subtotal: calc.subtotal,
    gst_mode: calc.gstMode,
    gst_rate: calc.gstRate,
    gst_amount: calc.gstAmount,
    total_amount: calc.totalAmount,
    include_pass_code_on_bill: includePassCodeOnBill,
    created_at: new Date()
  };

  // Generate First Pass PDF (or primary pass)
  const passPdfBuffer = await generatePassPdf({
    style,
    pass: result.createdPasses[0],
    event,
    category,
    customer: { name: customerName, email: customerEmail, phone: customerPhone },
    sponsor: sponsorName
  });

  // Generate Bill PDF
  const billPdfBuffer = await generateBillPdf({
    billing: billingRecord,
    event,
    category,
    passes: result.createdPasses
  });

  // 4. Handle Email Dispatch if requested (Event-Scoped SMTP Delivery)
  let emailDelivery = { success: false, status: 'NOT_REQUESTED' };
  if ((sendVia === 'EMAIL' || sendVia === 'BOTH') && customerEmail) {
    const subject = emailSubject || `${event.event_name} — Your Official Entry Pass & Invoice (${result.billNumber})`;

    const emailHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #1E293B; line-height: 1.6;">
        <div style="background-color: #0F172A; padding: 24px; text-align: center; border-radius: 8px 8px 0 0;">
          <h1 style="color: #FFFFFF; margin: 0; font-size: 22px;">${event.event_name}</h1>
          <p style="color: #94A3B8; margin: 6px 0 0 0; font-size: 13px;">Official Pass Confirmation & Tax Invoice</p>
        </div>
        <div style="padding: 24px; border: 1px solid #E2E8F0; border-top: none; background-color: #FFFFFF; border-radius: 0 0 8px 8px;">
          <p>Dear <strong>${customerName}</strong>,</p>
          <p>Thank you for purchasing your pass for <strong>${event.event_name}</strong>! Your entry pass and itemized tax invoice are attached to this email.</p>
          
          <div style="background-color: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 6px; padding: 16px; margin: 20px 0;">
            <table style="width: 100%; font-size: 13.5px;">
              <tr><td style="color: #64748B;">Category:</td><td><strong>${category.name}</strong></td></tr>
              <tr><td style="color: #64748B;">Pass Code:</td><td style="font-family: monospace; font-weight: bold; color: #2563EB;">${result.createdPasses.map(p => p.code).join(', ')}</td></tr>
              <tr><td style="color: #64748B;">Quantity:</td><td><strong>${calc.quantity}</strong></td></tr>
              <tr><td style="color: #64748B;">Total Amount:</td><td><strong style="color: #047857;">₹${calc.totalAmount.toFixed(2)}</strong></td></tr>
              ${sponsorName ? `<tr><td style="color: #64748B;">Sponsor:</td><td>${sponsorName}</td></tr>` : ''}
            </table>
          </div>

          <p style="font-size: 13px; color: #64748B;">
            <strong>Important:</strong> Please download and present the attached Pass PDF with its scannable barcode at the entrance gate for instant entry.
          </p>

          <hr style="border: none; border-top: 1px solid #E2E8F0; margin: 24px 0;" />
          <p style="font-size: 11.5px; color: #94A3B8; text-align: center;">
            ${event.event_name} • ${event.venue || 'Event Venue'}<br />
            This is an automated pass confirmation.
          </p>
        </div>
      </div>
    `;

    emailDelivery = await eventDeliveryService.sendEventEmail({
      eventId,
      billingId: result.billingId,
      to: customerEmail,
      subject,
      html: emailHtml,
      attachments: [
        {
          filename: `Pass_${result.createdPasses[0].code}.pdf`,
          content: passPdfBuffer,
          contentType: 'application/pdf'
        },
        {
          filename: `Invoice_${result.billNumber}.pdf`,
          content: billPdfBuffer,
          contentType: 'application/pdf'
        }
      ]
    });
  }

  // 5. Handle WhatsApp Delivery if requested (Event-Scoped WhatsApp Delivery)
  let whatsappDelivery = { success: false, status: 'NOT_REQUESTED' };
  if (sendVia === 'WHATSAPP' || sendVia === 'BOTH') {
    whatsappDelivery = await eventDeliveryService.generateEventWhatsappDelivery({
      eventId,
      customerPhone,
      customerName,
      eventName: event.event_name,
      passCodes: result.createdPasses.map(p => p.code),
      totalAmount: calc.totalAmount,
      billingId: result.billingId,
      downloadToken: result.downloadToken,
      baseUrl: baseUrl || null,
      passPdfBuffer,
      billPdfBuffer
    });
  }

  return {
    success: true,
    message: 'Passes and Bill generated successfully',
    billing: {
      ...billingRecord,
      id: result.billingId,
      download_token: result.downloadToken
    },
    passes: result.createdPasses,
    emailSent: emailDelivery.status === 'SENT',
    emailDelivery,
    whatsappUrl: whatsappDelivery.whatsappUrl || null,
    whatsappDelivery,
    passPdfBase64: passPdfBuffer.toString('base64'),
    billPdfBase64: billPdfBuffer.toString('base64')
  };
}

/**
 * Get paginated billing history
 */
async function getBillingHistory({ eventId = null, page = 1, limit = 20, search = '' }) {
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const pageLimit = Math.min(100, Math.max(10, parseInt(limit, 10) || 20));
  const offset = (pageNum - 1) * pageLimit;

  const whereConditions = [];
  const queryParams = [];

  if (eventId) {
    whereConditions.push('b.event_id = ?');
    queryParams.push(parseInt(eventId, 10));
  }

  if (search && search.trim()) {
    const s = `%${search.trim()}%`;
    whereConditions.push('(b.bill_number LIKE ? OR b.customer_name LIKE ? OR b.customer_email LIKE ? OR b.customer_phone LIKE ?)');
    queryParams.push(s, s, s, s);
  }

  const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

  const [countRes] = await query(
    `SELECT COUNT(*) as total FROM billings b ${whereClause}`,
    queryParams
  );
  const totalRecords = countRes?.total || 0;
  const totalPages = Math.ceil(totalRecords / pageLimit);

  const billings = await query(
    `SELECT b.*, e.event_name, c.name as category_name, s.name as style_name, u.name as issued_by_name
     FROM billings b
     JOIN events e ON b.event_id = e.id
     JOIN pass_categories c ON b.category_id = c.id
     LEFT JOIN pass_styles s ON b.style_id = s.id
     LEFT JOIN users u ON b.created_by = u.id
     ${whereClause}
     ORDER BY b.id DESC
     LIMIT ? OFFSET ?`,
    [...queryParams, pageLimit, offset]
  );

  return {
    billings,
    pagination: {
      page: pageNum,
      limit: pageLimit,
      totalRecords,
      totalPages
    }
  };
}

module.exports = {
  calculateGst,
  issuePassesAndBill,
  getBillingHistory
};
