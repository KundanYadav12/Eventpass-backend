const ExcelJS = require('exceljs');
const { query, withTransaction } = require('../config/db');
const { generatePassCode, generateHmacSignature, generateSecureToken } = require('../utils/cryptoUtil');
const { logAudit } = require('./AuditService');
const {
  formatDateTimeIST,
  formatDateIST,
  formatTimeIST,
  formatMySqlDateTime,
  getISTDateRangeBoundsUTC
} = require('../utils/timeUtil');
const { generatePassPdf, generateBillPdf } = require('./pdfService');
const eventDeliveryService = require('./eventDeliveryService');

/**
 * Get paginated list of passes with event scoping and dynamic filters
 */
async function getPasses({
  eventId = null,
  categoryId = null,
  page = 1,
  limit = 20,
  search = '',
  passType = '',
  status = '',
  sharingMethod = '',
  printed = '',
  usageState = '',
  validityState = '',
  dateFrom = '',
  dateTo = '',
  sharedFrom = '',
  sharedTo = '',
  sortBy = 'id',
  sortDir = 'DESC'
}) {
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const pageLimit = Math.min(100, Math.max(5, parseInt(limit, 10) || 20));
  const offset = (pageNum - 1) * pageLimit;

  const whereConditions = [];
  const queryParams = [];

  // Scoped by event_id
  if (eventId) {
    whereConditions.push('p.event_id = ?');
    queryParams.push(parseInt(eventId, 10));
  }

  // Scoped by category_id
  if (categoryId && categoryId !== 'all') {
    whereConditions.push('p.category_id = ?');
    queryParams.push(parseInt(categoryId, 10));
  }

  // Search by Pass Code, ID, Customer Name, Email, Phone, Sponsor, or Bill Number
  if (search && search.trim()) {
    const cleanSearch = search.trim();
    const searchWildcard = `%${cleanSearch}%`;
    if (/^\d+$/.test(cleanSearch)) {
      whereConditions.push('(p.id = ? OR p.code LIKE ? OR p.customer_name LIKE ? OR p.customer_email LIKE ? OR p.customer_phone LIKE ? OR b.bill_number LIKE ?)');
      queryParams.push(parseInt(cleanSearch, 10), searchWildcard, searchWildcard, searchWildcard, searchWildcard, searchWildcard);
    } else {
      whereConditions.push('(p.code LIKE ? OR p.customer_name LIKE ? OR p.customer_email LIKE ? OR p.customer_phone LIKE ? OR p.sponsor_name LIKE ? OR b.bill_number LIKE ?)');
      queryParams.push(searchWildcard, searchWildcard, searchWildcard, searchWildcard, searchWildcard, searchWildcard);
    }
  }

  // Filter by Pass Type / Category code
  if (passType && passType !== 'all') {
    whereConditions.push('(p.code_type = ? OR c.code = ?)');
    queryParams.push(passType, passType);
  }

  // Filter by Status (active, used, expired, void)
  if (status && status !== 'all') {
    whereConditions.push('p.status = ?');
    queryParams.push(status);
  }

  // Filter by Sharing Method (EMAIL, WHATSAPP, BOTH, NONE)
  if (sharingMethod && sharingMethod !== 'all') {
    whereConditions.push('p.sharing_method = ?');
    queryParams.push(sharingMethod);
  }

  // Filter by Printed status
  if (printed === 'true' || printed === '1') {
    whereConditions.push('p.printed = 1');
  } else if (printed === 'false' || printed === '0') {
    whereConditions.push('p.printed = 0');
  }

  // Filter by Used / Unused
  if (usageState === 'used') {
    whereConditions.push('(p.status = "used" OR p.scan_count > 0)');
  } else if (usageState === 'unused') {
    whereConditions.push('(p.status != "used" AND p.scan_count = 0)');
  }

  // Filter by Validity (valid / expired)
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  if (validityState === 'valid') {
    whereConditions.push('p.valid_until >= ? AND p.status != "void" AND p.status != "expired"');
    queryParams.push(now);
  } else if (validityState === 'expired') {
    whereConditions.push('(p.valid_until < ? OR p.status = "expired")');
    queryParams.push(now);
  }

  // Validity Date Range filter (in IST)
  if (dateFrom || dateTo) {
    const { startUtc, endUtc } = getISTDateRangeBoundsUTC(dateFrom, dateTo);
    if (startUtc) {
      whereConditions.push('p.valid_from >= ?');
      queryParams.push(startUtc);
    }
    if (endUtc) {
      whereConditions.push('p.valid_until <= ?');
      queryParams.push(endUtc);
    }
  }

  // Shared Date Range filter (in IST)
  if (sharedFrom || sharedTo) {
    const { startUtc, endUtc } = getISTDateRangeBoundsUTC(sharedFrom, sharedTo);
    if (startUtc) {
      whereConditions.push('p.last_shared_at >= ?');
      queryParams.push(startUtc);
    }
    if (endUtc) {
      whereConditions.push('p.last_shared_at <= ?');
      queryParams.push(endUtc);
    }
  }

  const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

  const allowedSorts = [
    'id', 'code', 'code_type', 'status', 'valid_from', 'valid_until',
    'scan_count', 'printed', 'created_at', 'last_scanned_at', 'first_scanned_at',
    'customer_name', 'customer_email', 'customer_phone', 'sharing_method',
    'first_shared_at', 'last_shared_at', 'reshare_count'
  ];
  const safeSortBy = allowedSorts.includes(sortBy) ? `p.${sortBy}` : 'p.id';
  const safeSortDir = sortDir.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

  // Count total records
  const countSql = `
    SELECT COUNT(*) as total
    FROM passes p
    LEFT JOIN pass_categories c ON p.category_id = c.id
    LEFT JOIN billings b ON p.billing_id = b.id
    ${whereClause}
  `;
  const [countResult] = await query(countSql, queryParams);
  const totalRecords = countResult ? countResult.total : 0;
  const totalPages = Math.ceil(totalRecords / pageLimit);

  // Fetch paginated rows with full customer and billing details
  const dataSql = `
    SELECT p.id, p.event_id, p.category_id, p.code, p.code_type, p.category_prefix, p.status,
           p.valid_from, p.valid_until, p.issued_at, p.first_scanned_at, p.last_scanned_at,
           p.scan_count, p.printed, p.print_batch_id, p.billing_id, p.style_id,
           p.customer_name, p.customer_email, p.customer_phone, p.sponsor_name,
           p.sharing_method, p.source, p.self_registration_id, p.first_shared_at, p.last_shared_at, p.reshare_count, p.shared_by,
           p.created_at, p.updated_at,
           c.name as category_name, c.price as category_price,
           e.event_name, e.event_code,
           b.bill_number, b.total_amount, b.gst_mode, b.gst_amount, b.download_token,
           u.name as shared_by_name
    FROM passes p
    LEFT JOIN pass_categories c ON (p.category_id = c.id OR (p.code_type = c.code AND p.event_id = c.event_id))
    LEFT JOIN events e ON p.event_id = e.id
    LEFT JOIN billings b ON p.billing_id = b.id
    LEFT JOIN users u ON p.shared_by = u.id
    ${whereClause}
    ORDER BY ${safeSortBy} ${safeSortDir}
    LIMIT ? OFFSET ?
  `;

  const passes = await query(dataSql, [...queryParams, pageLimit, offset]);

  return {
    passes,
    pagination: {
      page: pageNum,
      limit: pageLimit,
      totalRecords,
      totalPages,
      hasPrev: pageNum > 1,
      hasNext: pageNum < totalPages
    }
  };
}

/**
 * Get single pass details with scan history, print logs, and communication history
 */
async function getPassDetails(id) {
  const passes = await query(
    `SELECT p.*,
            c.name as category_name, c.description as category_description, c.price as category_price,
            e.id as event_id, e.event_name, e.event_code, e.venue,
            pb.name as print_batch_name, pb.status as print_batch_status,
            b.bill_number, b.download_token, b.subtotal, b.gst_mode, b.gst_amount, b.total_amount,
            u.name as shared_by_name
     FROM passes p
     LEFT JOIN pass_categories c ON (p.category_id = c.id OR (p.code_type = c.code AND p.event_id = c.event_id))
     LEFT JOIN events e ON p.event_id = e.id
     LEFT JOIN print_batches pb ON p.print_batch_id = pb.id
     LEFT JOIN billings b ON p.billing_id = b.id
     LEFT JOIN users u ON p.shared_by = u.id
     WHERE p.id = ?`,
    [id]
  );

  if (passes.length === 0) {
    return null;
  }

  const pass = passes[0];

  // Fetch communication and reshare history
  const communicationHistory = await query(
    `SELECT pch.*, u.name as operator_name
     FROM pass_communication_history pch
     LEFT JOIN users u ON pch.shared_by = u.id
     WHERE pch.pass_id = ?
     ORDER BY pch.shared_at DESC`,
    [pass.id]
  );

  // Fetch scan history
  const scanHistory = await query(
    `SELECT sh.*, u.name as operator_name
     FROM scan_history sh
     LEFT JOIN users u ON sh.operator_id = u.id
     WHERE sh.pass_id = ? OR sh.pass_code = ?
     ORDER BY sh.scan_time DESC
     LIMIT 50`,
    [pass.id, pass.code]
  );

  // Fetch print logs
  const printLogs = await query(
    `SELECT pl.*, pb.name as batch_name
     FROM print_log pl
     LEFT JOIN print_batches pb ON pl.batch_id = pb.id
     WHERE pl.pass_id = ?
     ORDER BY pl.printed_at DESC`,
    [pass.id]
  );

  // Fetch audit history
  const auditHistory = await query(
    `SELECT * FROM audit_log
     WHERE entity = 'PASS' AND entity_id = ?
     ORDER BY created_at DESC
     LIMIT 20`,
    [String(pass.id)]
  );

  return {
    pass,
    communicationHistory,
    scanHistory,
    printLogs,
    auditHistory
  };
}

/**
 * Reshare an existing pass via Email and/or WhatsApp
 * Updates communication history and reshare counters without generating new pass codes.
 */
async function resharePass({
  passId,
  sharingMethod = 'EMAIL', // 'EMAIL' | 'WHATSAPP' | 'BOTH'
  customerEmail = null,
  customerPhone = null,
  emailSubject = null,
  notes = null,
  userId = null,
  userName = '',
  ipAddress = null,
  userAgent = null,
  baseUrl = null
}) {
  const passRows = await query(
    `SELECT p.*,
            c.name as category_name, c.code as category_code, c.price as category_price,
            e.id as resolved_event_id, e.event_name, e.event_code, e.venue,
            b.id as billing_id, b.bill_number, b.download_token, b.subtotal, b.gst_mode, b.gst_rate, b.gst_amount, b.total_amount,
            s.id as style_id, s.name as style_name
     FROM passes p
     JOIN events e ON p.event_id = e.id
     JOIN pass_categories c ON (p.category_id = c.id OR (p.code_type = c.code AND p.event_id = c.event_id))
     LEFT JOIN billings b ON p.billing_id = b.id
     LEFT JOIN pass_styles s ON p.style_id = s.id
     WHERE p.id = ?`,
    [passId]
  );

  if (!passRows || passRows.length === 0) {
    throw new Error('Pass not found');
  }

  const pass = passRows[0];
  const eventId = pass.event_id;
  const now = new Date();

  // Determine effective contact information (use incoming or existing)
  const targetCustomerName = pass.customer_name || 'Valued Guest';
  const targetEmail = customerEmail !== undefined && customerEmail !== null ? customerEmail.trim().toLowerCase() : (pass.customer_email || '');
  const targetPhone = customerPhone !== undefined && customerPhone !== null ? customerPhone.trim() : (pass.customer_phone || '');

  if (sharingMethod === 'EMAIL' && !targetEmail) {
    throw new Error('Valid email address is required for Email reshare');
  }
  if (sharingMethod === 'WHATSAPP' && !targetPhone) {
    throw new Error('Valid WhatsApp phone number is required for WhatsApp reshare');
  }
  if (sharingMethod === 'BOTH' && (!targetEmail || !targetPhone)) {
    throw new Error('Both Email address and WhatsApp number are required for dual-channel reshare');
  }

  // 1. Fetch style or default
  let style = null;
  if (pass.style_id) {
    const styleRows = await query('SELECT * FROM pass_styles WHERE id = ?', [pass.style_id]);
    if (styleRows && styleRows.length > 0) style = styleRows[0];
  }
  if (!style) {
    const defaultStyles = await query(
      'SELECT * FROM pass_styles WHERE (event_id = ? OR event_id IS NULL) ORDER BY is_default DESC, id ASC LIMIT 1',
      [eventId]
    );
    if (defaultStyles && defaultStyles.length > 0) style = defaultStyles[0];
  }

  // 2. Generate PDFs
  const passPdfBuffer = await generatePassPdf({
    style,
    pass: {
      code: pass.code,
      code_type: pass.code_type,
      category_name: pass.category_name,
      customer_name: targetCustomerName,
      sponsor_name: pass.sponsor_name,
      photo_url: pass.photo_url,
      custom_fields_data: pass.custom_fields_data
    },
    event: { id: pass.event_id, event_name: pass.event_name, venue: pass.venue },
    category: {
      id: pass.category_id,
      name: pass.category_name,
      code: pass.code_type,
      valid_from: pass.valid_from,
      valid_until: pass.valid_until
    },
    customer: { name: targetCustomerName, email: targetEmail, phone: targetPhone, photo_url: pass.photo_url },
    sponsor: pass.sponsor_name
  });

  let billPdfBuffer = null;
  if (pass.billing_id) {
    billPdfBuffer = await generateBillPdf({
      billing: {
        id: pass.billing_id,
        bill_number: pass.bill_number,
        customer_name: targetCustomerName,
        customer_email: targetEmail,
        customer_phone: targetPhone,
        sponsor_name: pass.sponsor_name,
        quantity: 1,
        unit_price: pass.category_price || 0,
        subtotal: pass.subtotal || pass.category_price || 0,
        gst_mode: pass.gst_mode || 'INCLUDED',
        gst_rate: pass.gst_rate || 18,
        gst_amount: pass.gst_amount || 0,
        total_amount: pass.total_amount || pass.category_price || 0,
        include_pass_code_on_bill: true,
        created_at: pass.created_at
      },
      event: { id: pass.event_id, event_name: pass.event_name, venue: pass.venue },
      category: { id: pass.category_id, name: pass.category_name },
      passes: [pass]
    });
  }

  // 3. Dispatch Email if selected
  let emailDelivery = { success: false, status: 'NOT_REQUESTED' };
  if ((sharingMethod === 'EMAIL' || sharingMethod === 'BOTH') && targetEmail) {
    const subject = emailSubject || `${pass.event_name} — Resent Official Pass Confirmation (${pass.code})`;

    const emailHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #1E293B; line-height: 1.6;">
        <div style="background-color: #0F172A; padding: 24px; text-align: center; border-radius: 8px 8px 0 0;">
          <h1 style="color: #FFFFFF; margin: 0; font-size: 22px;">${pass.event_name}</h1>
          <p style="color: #94A3B8; margin: 6px 0 0 0; font-size: 13px;">Official Pass Confirmation (Resent)</p>
        </div>
        <div style="padding: 24px; border: 1px solid #E2E8F0; border-top: none; background-color: #FFFFFF; border-radius: 0 0 8px 8px;">
          <p>Dear <strong>${targetCustomerName}</strong>,</p>
          <p>Here is your official pass confirmation for <strong>${pass.event_name}</strong>.</p>
          
          <div style="background-color: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 6px; padding: 16px; margin: 20px 0;">
            <table style="width: 100%; font-size: 13.5px;">
              <tr><td style="color: #64748B;">Category:</td><td><strong>${pass.category_name}</strong></td></tr>
              <tr><td style="color: #64748B;">Pass Code:</td><td style="font-family: monospace; font-weight: bold; color: #2563EB;">${pass.code}</td></tr>
              <tr><td style="color: #64748B;">Status:</td><td><strong style="color: #047857;">${pass.status.toUpperCase()}</strong></td></tr>
              ${pass.sponsor_name ? `<tr><td style="color: #64748B;">Sponsor:</td><td>${pass.sponsor_name}</td></tr>` : ''}
            </table>
          </div>

          <p style="font-size: 13px; color: #64748B;">
            <strong>Important:</strong> Please present the attached Pass PDF with its scannable barcode at the entrance gate.
          </p>

          <hr style="border: none; border-top: 1px solid #E2E8F0; margin: 24px 0;" />
          <p style="font-size: 11.5px; color: #94A3B8; text-align: center;">
            ${pass.event_name} • ${pass.venue || 'Event Venue'}<br />
            Resent by ${userName || 'Event Operations Team'} on ${formatDateTimeIST(now)}
          </p>
        </div>
      </div>
    `;

    const attachments = [
      {
        filename: `Pass_${pass.code}.pdf`,
        content: passPdfBuffer,
        contentType: 'application/pdf'
      }
    ];

    if (billPdfBuffer && pass.bill_number) {
      attachments.push({
        filename: `Invoice_${pass.bill_number}.pdf`,
        content: billPdfBuffer,
        contentType: 'application/pdf'
      });
    }

    emailDelivery = await eventDeliveryService.sendEventEmail({
      eventId,
      billingId: pass.billing_id,
      to: targetEmail,
      subject,
      html: emailHtml,
      attachments
    });
  }

  // 4. WhatsApp Delivery / Share Link if selected
  let whatsappDelivery = { success: false, status: 'NOT_REQUESTED' };
  if (sharingMethod === 'WHATSAPP' || sharingMethod === 'BOTH') {
    whatsappDelivery = await eventDeliveryService.generateEventWhatsappDelivery({
      eventId,
      customerPhone: targetPhone,
      customerName: targetCustomerName,
      eventName: pass.event_name,
      passCodes: [pass.code],
      totalAmount: pass.total_amount || pass.category_price || 0,
      billingId: pass.billing_id,
      downloadToken: pass.download_token || generateSecureToken(16),
      baseUrl: baseUrl || null,
      passPdfBuffer,
      billPdfBuffer
    });
  }

  // 5. Atomic Update in Transaction
  await withTransaction(async (conn) => {
    // Update pass record with latest contact information, sharing timestamp, and increment reshare_count
    await conn.query(
      `UPDATE passes
       SET customer_name = ?,
           customer_email = ?,
           customer_phone = ?,
           sharing_method = ?,
           first_shared_at = COALESCE(first_shared_at, NOW()),
           last_shared_at = NOW(),
           reshare_count = reshare_count + 1,
           shared_by = ?,
           updated_at = NOW()
       WHERE id = ?`,
      [
        targetCustomerName,
        targetEmail || null,
        targetPhone || null,
        sharingMethod,
        userId,
        passId
      ]
    );

    // If customer updated email/phone and pass has a linked bill, keep billing record aligned
    if (pass.billing_id) {
      await conn.query(
        `UPDATE billings
         SET customer_name = ?,
             customer_email = COALESCE(?, customer_email),
             customer_phone = COALESCE(?, customer_phone)
         WHERE id = ?`,
        [targetCustomerName, targetEmail || null, targetPhone || null, pass.billing_id]
      );
    }

    // Insert into pass_communication_history
    await conn.query(
      `INSERT INTO pass_communication_history (
        pass_id, event_id, billing_id, customer_name, customer_email, customer_phone,
        sharing_method, status, shared_by, shared_by_name, notes, shared_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        passId,
        eventId,
        pass.billing_id,
        targetCustomerName,
        targetEmail || null,
        targetPhone || null,
        sharingMethod,
        (emailDelivery.status === 'SENT' || whatsappDelivery.status === 'READY') ? 'SENT' : 'READY',
        userId,
        userName || 'Admin',
        notes || `Reshared via ${sharingMethod} by ${userName || 'Admin'}`
      ]
    );

    // Audit Log
    await conn.query(
      `INSERT INTO audit_log (event_id, user_id, user_name, action, entity, entity_id, new_value, ip_address, user_agent, created_at)
       VALUES (?, ?, ?, 'RESHARE_PASS', 'PASS', ?, ?, ?, ?, NOW())`,
      [
        eventId,
        userId,
        userName,
        String(passId),
        JSON.stringify({
          passCode: pass.code,
          sharingMethod,
          customerName: targetCustomerName,
          customerEmail: targetEmail,
          customerPhone: targetPhone,
          reshareCount: (pass.reshare_count || 0) + 1
        }),
        ipAddress,
        userAgent
      ]
    );
  });

  const updatedDetails = await getPassDetails(passId);

  return {
    success: true,
    message: `Pass ${pass.code} successfully reshared via ${sharingMethod}`,
    pass: updatedDetails.pass,
    communicationHistory: updatedDetails.communicationHistory,
    emailDelivery,
    whatsappUrl: whatsappDelivery.whatsappUrl || null,
    whatsappDelivery,
    passPdfBase64: passPdfBuffer.toString('base64'),
    billPdfBase64: billPdfBuffer ? billPdfBuffer.toString('base64') : null
  };
}

/**
 * Generate formatted Excel (.xlsx) workbook containing filtered pass inventory records
 */
async function exportPassesExcel(filters) {
  // Query all matching passes without small page limits (capped at 50,000 for server memory safety)
  const result = await getPasses({
    ...filters,
    page: 1,
    limit: 50000
  });

  const passes = result.passes || [];
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'EventGen Platform';
  workbook.created = new Date();

  const worksheet = workbook.addWorksheet('Pass Inventory', {
    views: [{ state: 'frozen', ySplit: 1 }]
  });

  // Define Columns
  worksheet.columns = [
    { header: 'Pass ID', key: 'id', width: 10 },
    { header: 'Pass Code', key: 'code', width: 14 },
    { header: 'Event Name', key: 'event_name', width: 24 },
    { header: 'Pass Category', key: 'category_name', width: 18 },
    { header: 'Customer / Buyer Name', key: 'customer_name', width: 24 },
    { header: 'Email Address', key: 'customer_email', width: 28 },
    { header: 'WhatsApp Number', key: 'customer_phone', width: 18 },
    { header: 'Sponsor', key: 'sponsor_name', width: 18 },
    { header: 'Price (₹)', key: 'price', width: 12 },
    { header: 'GST Mode', key: 'gst_mode', width: 12 },
    { header: 'GST Amount (₹)', key: 'gst_amount', width: 14 },
    { header: 'Total (₹)', key: 'total_amount', width: 14 },
    { header: 'Invoice #', key: 'bill_number', width: 18 },
    { header: 'Sharing Method', key: 'sharing_method', width: 16 },
    { header: 'First Shared (IST)', key: 'first_shared_at', width: 22 },
    { header: 'Last Shared (IST)', key: 'last_shared_at', width: 22 },
    { header: 'Reshare Count', key: 'reshare_count', width: 14 },
    { header: 'Scan Status', key: 'status', width: 14 },
    { header: 'Scan Count', key: 'scan_count', width: 12 },
    { header: 'First Scan Time (IST)', key: 'first_scanned_at', width: 22 },
    { header: 'Last Scan Time (IST)', key: 'last_scanned_at', width: 22 },
    { header: 'Valid From (IST)', key: 'valid_from', width: 20 },
    { header: 'Valid Until (IST)', key: 'valid_until', width: 20 },
    { header: 'Print Status', key: 'printed', width: 14 },
    { header: 'Created Date (IST)', key: 'created_at', width: 22 }
  ];

  // Style Header Row
  const headerRow = worksheet.getRow(1);
  headerRow.font = { name: 'Arial', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF1E293B' } // Slate 800
  };
  headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
  headerRow.height = 28;

  // Populate Data Rows with IST Formatted Timestamps
  for (const p of passes) {
    const row = worksheet.addRow({
      id: p.id,
      code: p.code,
      event_name: p.event_name || 'Event 2026',
      category_name: p.category_name || p.code_type,
      customer_name: p.customer_name || '—',
      customer_email: p.customer_email || '—',
      customer_phone: p.customer_phone || '—',
      sponsor_name: p.sponsor_name || '—',
      price: parseFloat(p.category_price || p.total_amount || 0),
      gst_mode: p.gst_mode || 'INCLUDED',
      gst_amount: parseFloat(p.gst_amount || 0),
      total_amount: parseFloat(p.total_amount || p.category_price || 0),
      bill_number: p.bill_number || '—',
      sharing_method: p.sharing_method || 'NONE',
      first_shared_at: formatDateTimeIST(p.first_shared_at),
      last_shared_at: formatDateTimeIST(p.last_shared_at),
      reshare_count: p.reshare_count || 0,
      status: (p.status || 'active').toUpperCase(),
      scan_count: p.scan_count || 0,
      first_scanned_at: formatDateTimeIST(p.first_scanned_at),
      last_scanned_at: formatDateTimeIST(p.last_scanned_at),
      valid_from: formatDateIST(p.valid_from),
      valid_until: formatDateIST(p.valid_until),
      printed: p.printed ? 'PRINTED' : 'UNPRINTED',
      created_at: formatDateTimeIST(p.created_at)
    });

    row.font = { name: 'Arial', size: 10 };
    row.alignment = { vertical: 'middle' };
  }

  // Auto-fit zebra striping and cell borders
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber > 1) {
      if (rowNumber % 2 === 0) {
        row.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFF8FAFC' }
        };
      }
      row.eachCell((cell) => {
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
          left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
          bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
          right: { style: 'thin', color: { argb: 'FFE2E8F0' } }
        };
      });
    }
  });

  return workbook.xlsx.writeBuffer();
}

/**
 * Generate passes for an event and category with collision-protected 7-character unique codes
 */
async function generatePasses({ eventId, categoryId, quantity, userId, userName, ipAddress, userAgent }) {
  const targetEventId = parseInt(eventId, 10);
  const targetCatId = parseInt(categoryId, 10);
  const count = parseInt(quantity, 10);

  if (!targetEventId || !targetCatId || !count || count <= 0) {
    throw new Error('Valid Event ID, Category ID, and Quantity are required');
  }

  const categoryRows = await query('SELECT * FROM pass_categories WHERE id = ? AND event_id = ?', [targetCatId, targetEventId]);
  if (!categoryRows || categoryRows.length === 0) {
    throw new Error('Category not found for the specified event');
  }

  const cat = categoryRows[0];
  const BATCH_CHUNK = 250;
  let generatedTotal = 0;

  await withTransaction(async (conn) => {
    while (generatedTotal < count) {
      const thisChunkSize = Math.min(BATCH_CHUNK, count - generatedTotal);
      const rows = [];

      for (let i = 0; i < thisChunkSize; i++) {
        const code = generatePassCode(); // Strictly 7-character unique code
        const hmac = generateHmacSignature(code);
        rows.push([
          targetEventId,
          cat.id,
          code,
          cat.code,
          cat.category_prefix || '',
          hmac,
          'active',
          cat.valid_from,
          cat.valid_until,
          false
        ]);
      }

      const placeholders = rows.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(',');
      const flatParams = rows.flat();

      const [insertRes] = await conn.query(
        `INSERT IGNORE INTO passes (event_id, category_id, code, code_type, category_prefix, hmac_sig, status, valid_from, valid_until, printed)
         VALUES ${placeholders}`,
        flatParams
      );

      generatedTotal += insertRes.affectedRows;
    }

    // Update category total_quantity
    await conn.query('UPDATE pass_categories SET total_quantity = total_quantity + ? WHERE id = ?', [generatedTotal, cat.id]);

    await conn.query(
      `INSERT INTO audit_log (event_id, user_id, user_name, action, entity, entity_id, new_value, ip_address, user_agent, created_at)
       VALUES (?, ?, ?, 'GENERATE_PASSES', 'PASS_CATEGORY', ?, ?, ?, ?, NOW())`,
      [
        targetEventId,
        userId,
        userName,
        String(cat.id),
        JSON.stringify({ eventId: targetEventId, categoryId: cat.id, generated: generatedTotal }),
        ipAddress,
        userAgent
      ]
    );
  });

  return {
    success: true,
    eventId: targetEventId,
    categoryId: cat.id,
    generatedCount: generatedTotal
  };
}

/**
 * Renew an individual pass
 */
async function renewPass(id, { validFrom, validUntil, resetUsage = false, resetStatus = true, reason, userId, userName, ipAddress, userAgent }) {
  const existing = await query('SELECT * FROM passes WHERE id = ?', [id]);
  if (existing.length === 0) {
    throw new Error('Pass not found');
  }

  const oldPass = existing[0];
  const newValidFrom = validFrom !== undefined ? formatMySqlDateTime(validFrom) : oldPass.valid_from;
  const newValidUntil = validUntil !== undefined ? formatMySqlDateTime(validUntil) : oldPass.valid_until;
  const newStatus = resetStatus ? 'active' : oldPass.status;
  const newScanCount = resetUsage ? 0 : oldPass.scan_count;
  const newFirstScanned = resetUsage ? null : oldPass.first_scanned_at;
  const newLastScanned = resetUsage ? null : oldPass.last_scanned_at;

  await query(
    `UPDATE passes
     SET valid_from = ?,
         valid_until = ?,
         status = ?,
         scan_count = ?,
         first_scanned_at = ?,
         last_scanned_at = ?,
         updated_at = NOW()
     WHERE id = ?`,
    [newValidFrom, newValidUntil, newStatus, newScanCount, newFirstScanned, newLastScanned, id]
  );

  await logAudit({
    eventId: oldPass.event_id,
    userId,
    userName,
    action: 'RENEW_PASS',
    entity: 'PASS',
    entityId: id,
    oldValue: { valid_from: oldPass.valid_from, valid_until: oldPass.valid_until, status: oldPass.status, scan_count: oldPass.scan_count },
    newValue: { valid_from: newValidFrom, valid_until: newValidUntil, status: newStatus, scan_count: newScanCount, reason: reason || 'Manual pass renewal' },
    ipAddress,
    userAgent
  });

  return getPassDetails(id);
}

/**
 * Bulk renew a group of passes
 */
async function bulkRenewPasses({ passIds = [], validFrom, validUntil, resetUsage = false, resetStatus = true, reason, userId, userName, ipAddress, userAgent }) {
  if (!Array.isArray(passIds) || passIds.length === 0) {
    throw new Error('No pass IDs provided for bulk renewal');
  }

  const formattedValidFrom = validFrom !== undefined ? formatMySqlDateTime(validFrom) : undefined;
  const formattedValidUntil = validUntil !== undefined ? formatMySqlDateTime(validUntil) : undefined;

  const results = await withTransaction(async (conn) => {
    let updatedCount = 0;

    for (const id of passIds) {
      const [rows] = await conn.query('SELECT * FROM passes WHERE id = ? FOR UPDATE', [id]);
      if (rows.length === 0) continue;

      const oldPass = rows[0];
      const newValidFrom = formattedValidFrom || oldPass.valid_from;
      const newValidUntil = formattedValidUntil || oldPass.valid_until;
      const newStatus = resetStatus ? 'active' : oldPass.status;
      const newScanCount = resetUsage ? 0 : oldPass.scan_count;

      await conn.query(
        `UPDATE passes
         SET valid_from = ?,
             valid_until = ?,
             status = ?,
             scan_count = ?,
             first_scanned_at = IF(? = 1, NULL, first_scanned_at),
             last_scanned_at = IF(? = 1, NULL, last_scanned_at),
             updated_at = NOW()
         WHERE id = ?`,
        [newValidFrom, newValidUntil, newStatus, newScanCount, resetUsage ? 1 : 0, resetUsage ? 1 : 0, id]
      );

      await conn.query(
        `INSERT INTO audit_log (event_id, user_id, user_name, action, entity, entity_id, old_value, new_value, ip_address, user_agent, created_at)
         VALUES (?, ?, ?, 'BULK_RENEW_PASS', 'PASS', ?, ?, ?, ?, ?, NOW())`,
        [
          oldPass.event_id,
          userId,
          userName,
          String(id),
          JSON.stringify({ valid_from: oldPass.valid_from, valid_until: oldPass.valid_until, status: oldPass.status }),
          JSON.stringify({ valid_from: newValidFrom, valid_until: newValidUntil, status: newStatus, reason }),
          ipAddress,
          userAgent
        ]
      );

      updatedCount++;
    }

    return { updatedCount };
  });

  return results;
}

/**
 * Void a pass
 */
async function voidPass(id, { reason, userId, userName, ipAddress, userAgent }) {
  const existing = await query('SELECT * FROM passes WHERE id = ?', [id]);
  if (existing.length === 0) {
    throw new Error('Pass not found');
  }

  const oldPass = existing[0];
  await query('UPDATE passes SET status = "void", updated_at = NOW() WHERE id = ?', [id]);

  await logAudit({
    eventId: oldPass.event_id,
    userId,
    userName,
    action: 'VOID_PASS',
    entity: 'PASS',
    entityId: id,
    oldValue: { status: oldPass.status },
    newValue: { status: 'void', reason: reason || 'SuperAdmin voided pass' },
    ipAddress,
    userAgent
  });

  return getPassDetails(id);
}

/**
 * Reissue a pass with new 7-character code and HMAC
 */
async function reissuePass(id, { reason, userId, userName, ipAddress, userAgent }) {
  const existing = await query('SELECT * FROM passes WHERE id = ?', [id]);
  if (existing.length === 0) {
    throw new Error('Pass not found');
  }

  const oldPass = existing[0];
  const newCode = generatePassCode(); // Strictly 7 characters
  const newHmac = generateHmacSignature(newCode);

  await query(
    `UPDATE passes
     SET code = ?,
         hmac_sig = ?,
         status = 'active',
         scan_count = 0,
         first_scanned_at = NULL,
         last_scanned_at = NULL,
         printed = 0,
         print_batch_id = NULL,
         updated_at = NOW()
     WHERE id = ?`,
    [newCode, newHmac, id]
  );

  await logAudit({
    eventId: oldPass.event_id,
    userId,
    userName,
    action: 'REISSUE_PASS',
    entity: 'PASS',
    entityId: id,
    oldValue: { code: oldPass.code, status: oldPass.status },
    newValue: { code: newCode, status: 'active', reason: reason || 'SuperAdmin reissued pass' },
    ipAddress,
    userAgent
  });

  return getPassDetails(id);
}

module.exports = {
  getPasses,
  getPassDetails,
  resharePass,
  exportPassesExcel,
  generatePasses,
  renewPass,
  bulkRenewPasses,
  voidPass,
  reissuePass
};
