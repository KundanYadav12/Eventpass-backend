const { query, withTransaction } = require('../config/db');
const { generatePassCode, generateHmacSignature, generateSecureToken } = require('../utils/cryptoUtil');
const { calculateGst } = require('./BillingService');
const { logAudit } = require('./AuditService');
const { generatePassPdf, generateMultiPassPdf, generateBillPdf } = require('./pdfService');
const eventDeliveryService = require('./eventDeliveryService');
const { formatDateTimeIST, formatDateIST } = require('../utils/timeUtil');
const ExcelJS = require('exceljs');

/**
 * Sell passes within assigned cashier allocation with strict race-condition & pricing controls
 */
async function sellPasses({
  cashierId,
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
  sendVia = 'NONE',
  senderName = '',
  senderEmail = '',
  emailSubject = '',
  ipAddress = null,
  userAgent = null,
  baseUrl = null
}) {
  const qty = Math.max(1, parseInt(quantity, 10) || 1);
  if (!cashierId || !eventId || !categoryId || !customerName || !customerName.trim()) {
    throw new Error('Cashier ID, Event ID, Category ID, and Customer Name are required');
  }

  // Validate dispatch requirements
  const normalizedSendVia = (sendVia || 'NONE').toUpperCase();
  if (normalizedSendVia === 'EMAIL' || normalizedSendVia === 'BOTH') {
    if (!customerEmail || !customerEmail.trim()) {
      throw new Error('Customer email is required when Email dispatch is selected');
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(customerEmail.trim())) {
      throw new Error('A valid customer email address is required for Email dispatch');
    }
  }

  if (normalizedSendVia === 'WHATSAPP' || normalizedSendVia === 'BOTH') {
    if (!customerPhone || !customerPhone.trim()) {
      throw new Error('Customer mobile number is required when WhatsApp dispatch is selected');
    }
    const digitsOnly = customerPhone.replace(/[^0-9]/g, '');
    if (digitsOnly.length < 10) {
      throw new Error('A valid mobile number (at least 10 digits) is required for WhatsApp dispatch');
    }
  }

  // Normalize phone number (prepending +91 for standard 10-digit Indian numbers)
  if (customerPhone && customerPhone.trim()) {
    const digits = customerPhone.replace(/[^0-9]/g, '');
    if (digits.length === 10 && /^[6-9]/.test(digits)) {
      customerPhone = `+91${digits}`;
    } else {
      customerPhone = customerPhone.trim();
    }
  } else {
    customerPhone = null;
  }

  // 1. Fetch user to verify active Cashier status & event assignment
  const cashierRows = await query(
    `SELECT u.id, u.name, u.email, u.role_id, u.event_id, r.name as role_name
     FROM users u
     JOIN roles r ON u.role_id = r.id
     WHERE u.id = ? AND u.is_active = 1`,
    [cashierId]
  );

  if (!cashierRows || cashierRows.length === 0) {
    throw new Error('Cashier user is inactive or not found');
  }
  const cashierUser = cashierRows[0];

  // Cashier must be assigned to the event (SuperAdmin exempt)
  if (cashierUser.role_name !== 'SUPERADMIN' && cashierUser.event_id && cashierUser.event_id !== parseInt(eventId, 10)) {
    throw new Error('You are not authorized to sell passes for this event');
  }

  // 2. Fetch Event and Category
  const eventRows = await query('SELECT * FROM events WHERE id = ?', [eventId]);
  if (!eventRows || eventRows.length === 0) throw new Error('Event not found');
  const event = eventRows[0];

  const catRows = await query('SELECT * FROM pass_categories WHERE id = ? AND event_id = ?', [categoryId, eventId]);
  if (!catRows || catRows.length === 0) throw new Error('Pass category not found for this event');
  const category = catRows[0];

  // 3. Minimum Selling Price Enforcement (Server-Side Strict Validation)
  const categoryBasePrice = parseFloat(category.price || 0);
  const minSellingPrice = parseFloat(category.min_selling_price || 0);
  const requestedUnitPrice = unitPrice !== null && unitPrice !== undefined ? parseFloat(unitPrice) : categoryBasePrice;

  if (minSellingPrice > 0 && requestedUnitPrice < minSellingPrice) {
    throw new Error(`Selling price (₹${requestedUnitPrice.toFixed(2)}) cannot be lower than the minimum selling price of ₹${minSellingPrice.toFixed(2)}`);
  }

  if (requestedUnitPrice < 0) {
    throw new Error('Selling price cannot be negative');
  }

  // Pass Style
  let style = null;
  if (styleId) {
    const styleRows = await query('SELECT * FROM pass_styles WHERE id = ?', [styleId]);
    if (styleRows && styleRows.length > 0) style = styleRows[0];
  }
  if (!style) {
    const defaultStyles = await query(
      'SELECT * FROM pass_styles WHERE (event_id = ? OR event_id IS NULL) ORDER BY is_default DESC, id ASC LIMIT 1',
      [eventId]
    );
    if (defaultStyles && defaultStyles.length > 0) style = defaultStyles[0];
  }

  const calc = calculateGst({
    unitPrice: requestedUnitPrice,
    quantity: qty,
    gstMode,
    gstRate
  });

  const isShared = sendVia && sendVia !== 'NONE';

  // 4. Atomic Transaction with Row-Level Lock on Allocation
  const saleResult = await withTransaction(async (conn) => {
    // Acquire row-level lock on cashier allocation to prevent overselling race conditions
    const [allocations] = await conn.query(
      `SELECT id, allocated_quantity, sold_quantity
       FROM cashier_allocations
       WHERE event_id = ? AND category_id = ? AND cashier_id = ?
       FOR UPDATE`,
      [eventId, categoryId, cashierId]
    );

    let allocationId = null;
    let remainingAllocation = 0;

    if (cashierUser.role_name === 'SUPERADMIN') {
      // SuperAdmin has direct authority
      allocationId = allocations.length > 0 ? allocations[0].id : null;
      remainingAllocation = 999999;
    } else {
      if (!allocations || allocations.length === 0) {
        throw new Error('No pass quota has been allocated to you for this category. Please contact your event administrator.');
      }

      const allocation = allocations[0];
      const available = allocation.allocated_quantity - allocation.sold_quantity;

      if (available < qty) {
        throw new Error(`Insufficient pass allocation quota. Requested: ${qty}, Remaining: ${Math.max(0, available)}`);
      }

      allocationId = allocation.id;
      remainingAllocation = available - qty;

      // Increment sold quantity atomically
      await conn.query(
        `UPDATE cashier_allocations
         SET sold_quantity = sold_quantity + ?, updated_at = NOW()
         WHERE id = ?`,
        [qty, allocationId]
      );
    }

    // Generate Invoice Number
    const [lastBill] = await conn.query('SELECT MAX(id) as max_id FROM billings');
    const nextNum = (lastBill[0]?.max_id || 0) + 1;
    const billNumber = `INV-${new Date().getFullYear()}-${String(nextNum).padStart(4, '0')}`;
    const downloadToken = generateSecureToken(16);

    // Insert Billing Record
    const [billRes] = await conn.query(
      `INSERT INTO billings (
        bill_number, download_token, event_id, category_id, style_id, customer_name, customer_email,
        customer_phone, sponsor_name, quantity, unit_price, subtotal, gst_mode,
        gst_rate, gst_amount, total_amount, include_pass_code_on_bill, sent_via,
        created_by, cashier_id, allocation_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
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
        1,
        sendVia,
        cashierId,
        cashierId,
        allocationId
      ]
    );

    const billingId = billRes.insertId;

    // Generate Pass records
    const createdPasses = [];
    for (let i = 0; i < calc.quantity; i++) {
      const code = generatePassCode();
      const hmac = generateHmacSignature(code);

      const [passRes] = await conn.query(
        `INSERT INTO passes (
          event_id, category_id, code, code_type, category_prefix, hmac_sig,
          status, valid_from, valid_until, printed, billing_id, style_id,
          customer_name, customer_email, customer_phone, sponsor_name,
          sharing_method, first_shared_at, last_shared_at, reshare_count, shared_by,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, false, ?, ?, ?, ?, ?, ?, ?, IF(? = 1, NOW(), NULL), IF(? = 1, NOW(), NULL), 0, ?, NOW())`,
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
          sponsorName ? sponsorName.trim() : null,
          sendVia,
          isShared ? 1 : 0,
          isShared ? 1 : 0,
          cashierId
        ]
      );

      const passId = passRes.insertId;

      if (isShared) {
        await conn.query(
          `INSERT INTO pass_communication_history (
            pass_id, event_id, billing_id, customer_name, customer_email, customer_phone,
            sharing_method, status, shared_by, shared_by_name, notes, shared_at, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'SENT', ?, ?, 'Cashier Counter Issue & Dispatch', NOW(), NOW())`,
          [
            passId,
            eventId,
            billingId,
            customerName.trim(),
            customerEmail ? customerEmail.trim().toLowerCase() : null,
            customerPhone ? customerPhone.trim() : null,
            sendVia,
            cashierId,
            cashierUser.name
          ]
        );
      }

      createdPasses.push({
        id: passId,
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
       VALUES (?, ?, ?, 'CASHIER_SALE', 'BILLING', ?, ?, ?, ?, NOW())`,
      [
        eventId,
        cashierId,
        cashierUser.name,
        String(billingId),
        JSON.stringify({
          billNumber,
          customerName,
          quantity: calc.quantity,
          unitPrice: calc.unitPrice,
          totalAmount: calc.totalAmount,
          allocationId,
          remainingAllocation
        }),
        ipAddress,
        userAgent
      ]
    );

    return {
      billingId,
      billNumber,
      downloadToken,
      quantity: calc.quantity,
      unitPrice: calc.unitPrice,
      subtotal: calc.subtotal,
      gstAmount: calc.gstAmount,
      totalAmount: calc.totalAmount,
      remainingAllocation,
      createdPasses,
      event,
      category,
      style
    };
  });

  // 5. Generate PDFs & Dispatch Delivery via Email and/or WhatsApp
  const billingRecord = {
    id: saleResult.billingId,
    bill_number: saleResult.billNumber,
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
    include_pass_code_on_bill: true,
    created_at: new Date()
  };

  const passPdfs = await Promise.all(
    saleResult.createdPasses.map(async (pass) => {
      const buffer = await generatePassPdf({
        style: saleResult.style,
        pass,
        event: saleResult.event,
        category: saleResult.category,
        customer: { name: customerName, email: customerEmail, phone: customerPhone },
        sponsor: sponsorName
      });
      return { pass, code: pass.code, filename: `Pass_${pass.code}.pdf`, buffer };
    })
  );

  const multiPassPdfBuffer = await generateMultiPassPdf({
    style: saleResult.style,
    passes: saleResult.createdPasses,
    event,
    category,
    customer: { name: customerName, email: customerEmail, phone: customerPhone },
    sponsor: sponsorName
  });

  const billPdfBuffer = await generateBillPdf({
    billing: billingRecord,
    event: saleResult.event,
    category: saleResult.category,
    passes: saleResult.createdPasses
  });

  let emailDelivery = { success: false, status: 'NOT_REQUESTED' };
  if ((sendVia === 'EMAIL' || sendVia === 'BOTH') && customerEmail) {
    const subject = emailSubject || `${event.event_name} — Your Official Entry Pass & Invoice (${saleResult.billNumber})`;

    const emailHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #1E293B; line-height: 1.6;">
        <div style="background-color: #0F172A; padding: 24px; text-align: center; border-radius: 8px 8px 0 0;">
          <h1 style="color: #FFFFFF; margin: 0; font-size: 22px;">${event.event_name}</h1>
          <p style="color: #94A3B8; margin: 6px 0 0 0; font-size: 13px;">Official Pass Confirmation & Tax Invoice</p>
        </div>
        <div style="padding: 24px; border: 1px solid #E2E8F0; border-top: none; background-color: #FFFFFF; border-radius: 0 0 8px 8px;">
          <p>Dear <strong>${customerName}</strong>,</p>
          <p>Thank you for purchasing your pass for <strong>${event.event_name}</strong>! All <strong>${calc.quantity}</strong> entry pass(es) and your itemized tax invoice are attached to this email.</p>
          
          <div style="background-color: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 6px; padding: 16px; margin: 20px 0;">
            <table style="width: 100%; font-size: 13.5px;">
              <tr><td style="color: #64748B;">Category:</td><td><strong>${category.name}</strong></td></tr>
              <tr><td style="color: #64748B;">Pass Code(s):</td><td style="font-family: monospace; font-weight: bold; color: #2563EB;">${saleResult.createdPasses.map(p => p.code).join(', ')}</td></tr>
              <tr><td style="color: #64748B;">Quantity:</td><td><strong>${calc.quantity} pass(es)</strong></td></tr>
              <tr><td style="color: #64748B;">Total Amount:</td><td><strong style="color: #047857;">₹${calc.totalAmount.toFixed(2)}</strong></td></tr>
              ${sponsorName ? `<tr><td style="color: #64748B;">Sponsor:</td><td>${sponsorName}</td></tr>` : ''}
            </table>
          </div>

          <p style="font-size: 13px; color: #64748B;">
            <strong>Important:</strong> Please download and present the attached Pass PDF(s) with scannable barcodes at the entrance gate for instant entry.
          </p>

          <hr style="border: none; border-top: 1px solid #E2E8F0; margin: 24px 0;" />
          <p style="font-size: 11.5px; color: #94A3B8; text-align: center;">
            ${event.event_name} • ${event.venue || 'Event Venue'}<br />
            This is an automated pass confirmation.
          </p>
        </div>
      </div>
    `;

    const passAttachments = passPdfs.map(item => ({
      filename: item.filename,
      content: item.buffer,
      contentType: 'application/pdf'
    }));

    emailDelivery = await eventDeliveryService.sendEventEmail({
      eventId,
      billingId: saleResult.billingId,
      to: customerEmail,
      subject,
      html: emailHtml,
      attachments: [
        ...passAttachments,
        {
          filename: `Invoice_${saleResult.billNumber}.pdf`,
          content: billPdfBuffer,
          contentType: 'application/pdf'
        }
      ]
    });
  }

  let whatsappDelivery = { success: false, status: 'NOT_REQUESTED' };
  if (sendVia === 'WHATSAPP' || sendVia === 'BOTH') {
    whatsappDelivery = await eventDeliveryService.generateEventWhatsappDelivery({
      eventId,
      customerPhone,
      customerName,
      eventName: event.event_name,
      passCodes: saleResult.createdPasses.map(p => p.code),
      totalAmount: calc.totalAmount,
      billingId: saleResult.billingId,
      downloadToken: saleResult.downloadToken,
      baseUrl: baseUrl || null,
      passPdfBuffer: multiPassPdfBuffer,
      billPdfBuffer
    });
  }

  // 6. Return comprehensive response to Cashier with delivery details and PDF assets
  return {
    billingId: saleResult.billingId,
    billNumber: saleResult.billNumber,
    downloadToken: saleResult.downloadToken,
    customerName,
    customerEmail,
    customerPhone,
    categoryName: category.name,
    categoryCode: category.code,
    quantity: saleResult.quantity,
    unitPrice: saleResult.unitPrice,
    subtotal: saleResult.subtotal,
    gstAmount: saleResult.gstAmount,
    totalAmount: saleResult.totalAmount,
    remainingAllocation: saleResult.remainingAllocation,
    sendVia,
    emailSent: emailDelivery.status === 'SENT' || emailDelivery.simulated === true,
    emailDelivery,
    whatsappUrl: whatsappDelivery.whatsappUrl || null,
    whatsappDelivery,
    passPdfBase64: multiPassPdfBuffer.toString('base64'),
    billPdfBase64: billPdfBuffer.toString('base64'),
    passPdfs: passPdfs.map(p => ({
      code: p.code,
      filename: p.filename,
      base64: p.buffer.toString('base64')
    })),
    soldAt: new Date().toISOString(),
    soldAtIST: formatDateTimeIST(new Date())
  };
}

/**
 * Get cashier's own paginated sales records
 */
async function getMySales({
  cashierId,
  eventId = null,
  search = '',
  categoryId = null,
  dateFrom = '',
  dateTo = '',
  page = 1,
  limit = 20
}) {
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const pageLimit = Math.min(100, Math.max(5, parseInt(limit, 10) || 20));
  const offset = (pageNum - 1) * pageLimit;

  const whereConditions = ['b.cashier_id = ?'];
  const queryParams = [parseInt(cashierId, 10)];

  if (eventId) {
    whereConditions.push('b.event_id = ?');
    queryParams.push(parseInt(eventId, 10));
  }

  if (categoryId) {
    whereConditions.push('b.category_id = ?');
    queryParams.push(parseInt(categoryId, 10));
  }

  if (search && search.trim()) {
    whereConditions.push('(b.bill_number LIKE ? OR b.customer_name LIKE ? OR b.customer_email LIKE ? OR b.customer_phone LIKE ?)');
    const term = `%${search.trim()}%`;
    queryParams.push(term, term, term, term);
  }

  if (dateFrom) {
    whereConditions.push('b.created_at >= ?');
    queryParams.push(`${dateFrom} 00:00:00`);
  }

  if (dateTo) {
    whereConditions.push('b.created_at <= ?');
    queryParams.push(`${dateTo} 23:59:59`);
  }

  const whereClause = `WHERE ${whereConditions.join(' AND ')}`;

  // Total summary for cashier
  const summaryRows = await query(
    `SELECT COUNT(*) as total_bills,
            COALESCE(SUM(b.quantity), 0) as total_passes_sold,
            COALESCE(SUM(b.total_amount), 0) as total_revenue,
            COALESCE(AVG(b.unit_price), 0) as avg_unit_price
     FROM billings b
     ${whereClause}`,
    queryParams
  );

  const summary = summaryRows && summaryRows.length > 0 ? summaryRows[0] : null;
  const totalRecords = summary?.total_bills || 0;
  const totalPages = Math.ceil(totalRecords / pageLimit);

  // Paginated records
  const sales = await query(
    `SELECT b.id, b.bill_number, b.download_token, b.customer_name, b.customer_email, b.customer_phone,
            b.quantity, b.unit_price, b.subtotal, b.gst_amount, b.total_amount,
            b.sent_via, b.created_at,
            pc.name as category_name, pc.code as category_code,
            e.event_name, e.event_code
     FROM billings b
     JOIN pass_categories pc ON b.category_id = pc.id
     JOIN events e ON b.event_id = e.id
     ${whereClause}
     ORDER BY b.created_at DESC
     LIMIT ? OFFSET ?`,
    [...queryParams, pageLimit, offset]
  );

  return {
    summary: {
      totalBills: summary?.total_bills || 0,
      totalPassesSold: summary?.total_passes_sold || 0,
      totalRevenue: parseFloat(summary?.total_revenue || 0),
      avgUnitPrice: parseFloat(summary?.avg_unit_price || 0)
    },
    sales: sales.map(s => ({
      id: s.id,
      billNumber: s.bill_number,
      downloadToken: s.download_token,
      customerName: s.customer_name,
      customerEmail: s.customer_email,
      customerPhone: s.customer_phone,
      categoryName: s.category_name,
      categoryCode: s.category_code,
      eventName: s.event_name,
      quantity: s.quantity,
      unitPrice: parseFloat(s.unit_price),
      subtotal: parseFloat(s.subtotal),
      gstAmount: parseFloat(s.gst_amount),
      totalAmount: parseFloat(s.total_amount),
      sentVia: s.sent_via,
      createdAt: s.created_at,
      createdAtIST: formatDateTimeIST(s.created_at)
    })),
    pagination: {
      page: pageNum,
      limit: pageLimit,
      totalRecords,
      totalPages
    }
  };
}

/**
 * Export cashier's own authorized sales records to Excel
 */
async function exportMySalesExcel({ cashierId, eventId = null, search = '', dateFrom = '', dateTo = '' }) {
  const whereConditions = ['b.cashier_id = ?'];
  const queryParams = [parseInt(cashierId, 10)];

  if (eventId) {
    whereConditions.push('b.event_id = ?');
    queryParams.push(parseInt(eventId, 10));
  }

  if (search && search.trim()) {
    whereConditions.push('(b.bill_number LIKE ? OR b.customer_name LIKE ? OR b.customer_email LIKE ? OR b.customer_phone LIKE ?)');
    const term = `%${search.trim()}%`;
    queryParams.push(term, term, term, term);
  }

  if (dateFrom) {
    whereConditions.push('b.created_at >= ?');
    queryParams.push(`${dateFrom} 00:00:00`);
  }

  if (dateTo) {
    whereConditions.push('b.created_at <= ?');
    queryParams.push(`${dateTo} 23:59:59`);
  }

  const rows = await query(
    `SELECT b.*, pc.name as category_name, e.event_name
     FROM billings b
     JOIN pass_categories pc ON b.category_id = pc.id
     JOIN events e ON b.event_id = e.id
     WHERE ${whereConditions.join(' AND ')}
     ORDER BY b.created_at DESC`,
    queryParams
  );

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('My Sales');

  sheet.columns = [
    { header: 'Invoice #', key: 'bill_number', width: 18 },
    { header: 'Event', key: 'event_name', width: 25 },
    { header: 'Pass Category', key: 'category_name', width: 22 },
    { header: 'Customer Name', key: 'customer_name', width: 22 },
    { header: 'Customer Email', key: 'customer_email', width: 25 },
    { header: 'Customer Mobile', key: 'customer_phone', width: 18 },
    { header: 'Quantity', key: 'quantity', width: 12 },
    { header: 'Unit Price (₹)', key: 'unit_price', width: 15 },
    { header: 'Subtotal (₹)', key: 'subtotal', width: 15 },
    { header: 'GST Amount (₹)', key: 'gst_amount', width: 15 },
    { header: 'Total Amount (₹)', key: 'total_amount', width: 18 },
    { header: 'Dispatch Method', key: 'sent_via', width: 16 },
    { header: 'Sale Date & Time (IST)', key: 'created_at', width: 24 }
  ];

  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4F46E5' } };

  for (const r of rows) {
    sheet.addRow({
      bill_number: r.bill_number,
      event_name: r.event_name,
      category_name: r.category_name,
      customer_name: r.customer_name,
      customer_email: r.customer_email || '—',
      customer_phone: r.customer_phone || '—',
      quantity: r.quantity,
      unit_price: parseFloat(r.unit_price),
      subtotal: parseFloat(r.subtotal),
      gst_amount: parseFloat(r.gst_amount),
      total_amount: parseFloat(r.total_amount),
      sent_via: r.sent_via,
      created_at: formatDateTimeIST(r.created_at)
    });
  }

  return await workbook.xlsx.writeBuffer();
}

module.exports = {
  sellPasses,
  getMySales,
  exportMySalesExcel
};
