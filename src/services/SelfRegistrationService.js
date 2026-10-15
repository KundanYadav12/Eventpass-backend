const fs = require('fs');
const path = require('path');
const { query, withTransaction } = require('../config/db');
const { generatePassCode, generateHmacSignature, generateSecureToken } = require('../utils/cryptoUtil');
const { logAudit } = require('./AuditService');
const { generatePassPdf } = require('./pdfService');
const eventDeliveryService = require('./eventDeliveryService');
const { formatDateTimeIST, formatDateIST } = require('../utils/timeUtil');
const { acquireLock } = require('../config/redis');

/**
 * Standardized HTTP error generator
 */
function createHttpError(message, statusCode = 400, code = 'BAD_REQUEST') {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

/**
 * Save base64 image data URL to public uploads directory
 */
function saveBase64Image(base64Data, filenamePrefix = 'attendee') {
  if (!base64Data || typeof base64Data !== 'string' || !base64Data.startsWith('data:image')) {
    return null;
  }
  const match = base64Data.match(/^data:image\/([a-zA-Z0-9\-\+\.]+);base64,(.+)$/);
  if (!match) return null;

  const rawExt = match[1].toLowerCase();
  const ext = rawExt === 'jpeg' ? 'jpg' : rawExt.replace(/[^a-z0-9]/g, '');
  const buffer = Buffer.from(match[2], 'base64');
  const uploadDir = path.resolve(__dirname, '../../uploads/attendees');
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }
  const filename = `${filenamePrefix}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}.${ext || 'jpg'}`;
  const filePath = path.join(uploadDir, filename);
  fs.writeFileSync(filePath, buffer);
  return `/uploads/attendees/${filename}`;
}

/**
 * Validate phone number format (must be 10-15 digits after cleanup)
 */
function normalizePhoneNumber(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length < 10) return null;
  return digits;
}

/**
 * Validate email format
 */
function isValidEmail(email) {
  if (!email || typeof email !== 'string') return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

/**
 * Calculate actual binary byte size from base64 data string
 */
function getBase64ByteSize(base64Str) {
  if (!base64Str || typeof base64Str !== 'string') return 0;
  const commaIdx = base64Str.indexOf(',');
  const data = commaIdx >= 0 ? base64Str.substring(commaIdx + 1) : base64Str;
  const padding = data.endsWith('==') ? 2 : (data.endsWith('=') ? 1 : 0);
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

/**
 * Create a new Self Registration configuration
 */
async function createSelfRegistration({
  eventId,
  categoryId,
  passStyleId = null,
  title,
  description = null,
  startsAt = null,
  endsAt = null,
  deliveryChannel = 'BOTH',
  requireName = true,
  requirePhone = true,
  requireEmail = true,
  requireAddress = false,
  requireGender = false,
  requireAge = false,
  allowDuplicate = false,
  maxRegistrations = null,
  customFields = null,
  userId = null,
  userName = 'Admin',
  ipAddress = null,
  userAgent = null
}) {
  const targetEventId = parseInt(eventId, 10);
  const targetCategoryId = parseInt(categoryId, 10);

  if (!targetEventId || !targetCategoryId) {
    throw new Error('Valid Event and Category are required');
  }

  // 1. Verify Event exists
  const eventRows = await query('SELECT * FROM events WHERE id = ?', [targetEventId]);
  if (!eventRows || eventRows.length === 0) {
    throw new Error('Event not found');
  }
  const event = eventRows[0];

  // 2. Verify Category belongs to this Event
  const catRows = await query('SELECT * FROM pass_categories WHERE id = ? AND event_id = ?', [targetCategoryId, targetEventId]);
  if (!catRows || catRows.length === 0) {
    throw new Error('Selected Category does not belong to the specified Event');
  }
  const category = catRows[0];

  // 3. Verify Pass Style if provided
  let styleId = passStyleId ? parseInt(passStyleId, 10) : null;
  if (styleId) {
    const styleRows = await query('SELECT id, name FROM pass_styles WHERE id = ?', [styleId]);
    if (!styleRows || styleRows.length === 0) {
      styleId = null;
    }
  }

  // Fallback to default style for this event if not specified
  if (!styleId) {
    const defaultStyles = await query(
      'SELECT id FROM pass_styles WHERE (event_id = ? OR event_id IS NULL) ORDER BY is_default DESC, id ASC LIMIT 1',
      [targetEventId]
    );
    if (defaultStyles && defaultStyles.length > 0) {
      styleId = defaultStyles[0].id;
    }
  }

  // 4. Validate Delivery Channel
  const validChannels = ['WHATSAPP', 'EMAIL', 'BOTH'];
  const channel = validChannels.includes(deliveryChannel) ? deliveryChannel : 'BOTH';

  // 5. Generate secure, non-sequential unguessable cryptographic token (32 hex characters)
  const publicToken = generateSecureToken(32);

  const cleanTitle = title && title.trim() ? title.trim() : `${category.name} — Self Registration`;
  const cleanDesc = description && description.trim() ? description.trim() : null;
  const maxRegs = maxRegistrations ? Math.max(1, parseInt(maxRegistrations, 10)) : null;
  const cleanCustomFields = customFields ? (typeof customFields === 'string' ? customFields : JSON.stringify(customFields)) : null;

  const result = await query(
    `INSERT INTO self_registrations (
      public_token, event_id, category_id, pass_style_id, title, description,
      status, starts_at, ends_at, delivery_channel,
      require_name, require_phone, require_email, require_address, require_gender, require_age,
      allow_duplicate, max_registrations, registration_count, custom_fields, created_by, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NOW())`,
    [
      publicToken,
      targetEventId,
      targetCategoryId,
      styleId,
      cleanTitle,
      cleanDesc,
      startsAt || null,
      endsAt || null,
      channel,
      requireName ? 1 : 0,
      requirePhone ? 1 : 0,
      requireEmail ? 1 : 0,
      requireAddress ? 1 : 0,
      requireGender ? 1 : 0,
      requireAge ? 1 : 0,
      allowDuplicate ? 1 : 0,
      maxRegs,
      cleanCustomFields,
      userId
    ]
  );

  const insertedId = result.insertId;

  // Log Audit
  await logAudit({
    eventId: targetEventId,
    userId,
    userName,
    action: 'CREATE_SELF_REGISTRATION',
    entity: 'SELF_REGISTRATION',
    entityId: insertedId,
    newValue: {
      id: insertedId,
      publicToken,
      title: cleanTitle,
      categoryName: category.name,
      deliveryChannel: channel
    },
    ipAddress,
    userAgent
  });

  return getSelfRegistrationById(insertedId, { eventId: targetEventId, isSuperAdmin: true });
}

/**
 * Get paginated list of Self Registrations with event scoping
 */
async function getSelfRegistrations({
  eventId = null,
  isSuperAdmin = false,
  search = '',
  status = 'all',
  page = 1,
  limit = 20
}) {
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const pageLimit = Math.min(100, Math.max(5, parseInt(limit, 10) || 20));
  const offset = (pageNum - 1) * pageLimit;

  const whereConditions = [];
  const queryParams = [];

  // Scoped by event
  if (eventId && (!isSuperAdmin || eventId !== 'all')) {
    whereConditions.push('sr.event_id = ?');
    queryParams.push(parseInt(eventId, 10));
  }

  // Filter by status
  if (status && status !== 'all') {
    whereConditions.push('sr.status = ?');
    queryParams.push(status.toUpperCase());
  }

  // Search by title, event name, category name, or token
  if (search && search.trim()) {
    const term = `%${search.trim()}%`;
    whereConditions.push('(sr.title LIKE ? OR e.event_name LIKE ? OR c.name LIKE ? OR sr.public_token LIKE ?)');
    queryParams.push(term, term, term, term);
  }

  const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

  const countSql = `
    SELECT COUNT(*) as total
    FROM self_registrations sr
    JOIN events e ON sr.event_id = e.id
    JOIN pass_categories c ON sr.category_id = c.id
    ${whereClause}
  `;
  const countRes = await query(countSql, queryParams);
  const totalRecords = countRes[0]?.total || 0;
  const totalPages = Math.ceil(totalRecords / pageLimit) || 1;

  const listSql = `
    SELECT 
      sr.*,
      e.event_name,
      e.venue,
      e.event_start_date,
      e.event_end_date,
      c.name AS category_name,
      c.code AS category_code,
      c.price AS category_price,
      c.category_prefix,
      ps.name AS pass_style_name,
      u.name AS created_by_name,
      (SELECT COUNT(*) FROM passes p WHERE p.self_registration_id = sr.id) AS actual_passes_issued,
      (SELECT COUNT(*) FROM passes p WHERE p.self_registration_id = sr.id AND p.status = 'active') AS active_passes_count,
      (SELECT COUNT(*) FROM passes p WHERE p.self_registration_id = sr.id AND p.scan_count > 0) AS scanned_passes_count
    FROM self_registrations sr
    JOIN events e ON sr.event_id = e.id
    JOIN pass_categories c ON sr.category_id = c.id
    LEFT JOIN pass_styles ps ON sr.pass_style_id = ps.id
    LEFT JOIN users u ON sr.created_by = u.id
    ${whereClause}
    ORDER BY sr.id DESC
    LIMIT ? OFFSET ?
  `;

  const rows = await query(listSql, [...queryParams, pageLimit, offset]);

  return {
    data: rows,
    pagination: {
      page: pageNum,
      limit: pageLimit,
      totalRecords,
      totalPages
    }
  };
}

/**
 * Get Self Registration configuration by ID
 */
async function getSelfRegistrationById(id, { eventId = null, isSuperAdmin = false } = {}) {
  const targetId = parseInt(id, 10);
  if (!targetId) throw new Error('Valid Self Registration ID is required');

  const rows = await query(
    `SELECT 
      sr.*,
      e.event_name,
      e.venue,
      c.name AS category_name,
      c.code AS category_code,
      c.price AS category_price,
      ps.name AS pass_style_name,
      u.name AS created_by_name,
      (SELECT COUNT(*) FROM passes p WHERE p.self_registration_id = sr.id) AS actual_passes_issued
    FROM self_registrations sr
    JOIN events e ON sr.event_id = e.id
    JOIN pass_categories c ON sr.category_id = c.id
    LEFT JOIN pass_styles ps ON sr.pass_style_id = ps.id
    LEFT JOIN users u ON sr.created_by = u.id
    WHERE sr.id = ?`,
    [targetId]
  );

  if (!rows || rows.length === 0) {
    throw new Error('Self Registration configuration not found');
  }

  const record = rows[0];
  if (record.custom_fields) {
    try {
      record.customFields = typeof record.custom_fields === 'string' ? JSON.parse(record.custom_fields) : record.custom_fields;
    } catch (_) {
      record.customFields = [];
    }
  } else {
    record.customFields = [];
  }

  // Event Isolation check
  if (!isSuperAdmin && eventId && Number(record.event_id) !== Number(eventId)) {
    throw new Error('Forbidden: Unauthorized access to this event self registration');
  }

  return record;
}

/**
 * Update Self Registration configuration
 */
async function updateSelfRegistration(id, updateData, { eventId = null, isSuperAdmin = false, userId = null, userName = 'Admin', ipAddress = null, userAgent = null } = {}) {
  const current = await getSelfRegistrationById(id, { eventId, isSuperAdmin });

  const {
    categoryId,
    passStyleId,
    title,
    description,
    startsAt,
    endsAt,
    deliveryChannel,
    requireName,
    requirePhone,
    requireEmail,
    requireAddress,
    requireGender,
    requireAge,
    allowDuplicate,
    maxRegistrations,
    status,
    customFields
  } = updateData;

  // Validate category if changing
  let targetCategoryId = current.category_id;
  if (categoryId && parseInt(categoryId, 10) !== current.category_id) {
    const catRows = await query('SELECT id FROM pass_categories WHERE id = ? AND event_id = ?', [parseInt(categoryId, 10), current.event_id]);
    if (!catRows || catRows.length === 0) {
      throw new Error('Selected category does not belong to this event');
    }
    targetCategoryId = parseInt(categoryId, 10);
  }

  // Validate pass style if changing
  let targetStyleId = passStyleId !== undefined ? (passStyleId ? parseInt(passStyleId, 10) : null) : current.pass_style_id;

  const validChannels = ['WHATSAPP', 'EMAIL', 'BOTH'];
  const targetChannel = deliveryChannel && validChannels.includes(deliveryChannel) ? deliveryChannel : current.delivery_channel;
  const targetStatus = status && ['ACTIVE', 'DISABLED'].includes(status) ? status : current.status;
  const cleanCustomFields = customFields !== undefined
    ? (customFields ? (typeof customFields === 'string' ? customFields : JSON.stringify(customFields)) : null)
    : current.custom_fields;

  await query(
    `UPDATE self_registrations
     SET category_id = ?,
         pass_style_id = ?,
         title = ?,
         description = ?,
         starts_at = ?,
         ends_at = ?,
         delivery_channel = ?,
         require_name = ?,
         require_phone = ?,
         require_email = ?,
         require_address = ?,
         require_gender = ?,
         require_age = ?,
         allow_duplicate = ?,
         max_registrations = ?,
         status = ?,
         custom_fields = ?,
         updated_at = NOW()
     WHERE id = ?`,
    [
      targetCategoryId,
      targetStyleId,
      title !== undefined ? (title ? title.trim() : null) : current.title,
      description !== undefined ? (description ? description.trim() : null) : current.description,
      startsAt !== undefined ? startsAt : current.starts_at,
      endsAt !== undefined ? endsAt : current.ends_at,
      targetChannel,
      requireName !== undefined ? (requireName ? 1 : 0) : current.require_name,
      requirePhone !== undefined ? (requirePhone ? 1 : 0) : current.require_phone,
      requireEmail !== undefined ? (requireEmail ? 1 : 0) : current.require_email,
      requireAddress !== undefined ? (requireAddress ? 1 : 0) : current.require_address,
      requireGender !== undefined ? (requireGender ? 1 : 0) : current.require_gender,
      requireAge !== undefined ? (requireAge ? 1 : 0) : current.require_age,
      allowDuplicate !== undefined ? (allowDuplicate ? 1 : 0) : current.allow_duplicate,
      maxRegistrations !== undefined ? (maxRegistrations ? parseInt(maxRegistrations, 10) : null) : current.max_registrations,
      targetStatus,
      cleanCustomFields,
      current.id
    ]
  );

  // Log Audit
  await logAudit({
    eventId: current.event_id,
    userId,
    userName,
    action: 'UPDATE_SELF_REGISTRATION',
    entity: 'SELF_REGISTRATION',
    entityId: current.id,
    oldValue: { status: current.status, title: current.title, channel: current.delivery_channel },
    newValue: { status: targetStatus, title, channel: targetChannel },
    ipAddress,
    userAgent
  });

  return getSelfRegistrationById(current.id, { eventId: current.event_id, isSuperAdmin: true });
}

/**
 * Toggle Status between ACTIVE and DISABLED
 */
async function toggleSelfRegistrationStatus(id, { status, eventId = null, isSuperAdmin = false, userId = null, userName = 'Admin', ipAddress = null, userAgent = null } = {}) {
  const current = await getSelfRegistrationById(id, { eventId, isSuperAdmin });
  const newStatus = status ? status.toUpperCase() : (current.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE');

  if (!['ACTIVE', 'DISABLED'].includes(newStatus)) {
    throw new Error('Invalid status value. Must be ACTIVE or DISABLED.');
  }

  await query('UPDATE self_registrations SET status = ?, updated_at = NOW() WHERE id = ?', [newStatus, current.id]);

  await logAudit({
    eventId: current.event_id,
    userId,
    userName,
    action: newStatus === 'ACTIVE' ? 'ENABLE_SELF_REGISTRATION' : 'DISABLE_SELF_REGISTRATION',
    entity: 'SELF_REGISTRATION',
    entityId: current.id,
    oldValue: { status: current.status },
    newValue: { status: newStatus },
    ipAddress,
    userAgent
  });

  return { success: true, id: current.id, status: newStatus };
}

/**
 * Get attendees/passes generated via this Self Registration
 */
async function getSelfRegistrationAttendees(id, { eventId = null, isSuperAdmin = false, page = 1, limit = 50, search = '' } = {}) {
  const selfReg = await getSelfRegistrationById(id, { eventId, isSuperAdmin });

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const isExportAll = limit === 'all' || parseInt(limit, 10) > 500 || parseInt(limit, 10) === -1;
  const pageLimit = isExportAll ? 100000 : Math.min(500, Math.max(5, parseInt(limit, 10) || 50));
  const offset = (pageNum - 1) * pageLimit;

  const whereConditions = ['p.self_registration_id = ?'];
  const queryParams = [selfReg.id];

  if (search && search.trim()) {
    const term = `%${search.trim()}%`;
    whereConditions.push('(p.code LIKE ? OR p.customer_name LIKE ? OR p.customer_email LIKE ? OR p.customer_phone LIKE ?)');
    queryParams.push(term, term, term, term);
  }

  const whereClause = `WHERE ${whereConditions.join(' AND ')}`;

  const countRes = await query(`SELECT COUNT(*) as total FROM passes p ${whereClause}`, queryParams);
  const totalRecords = countRes[0]?.total || 0;
  const totalPages = Math.ceil(totalRecords / pageLimit) || 1;

  // Global counts for this self registration (independent of table filters)
  const [totalRegRow] = await query(
    `SELECT COUNT(*) as total_registered FROM passes WHERE self_registration_id = ?`,
    [selfReg.id]
  );
  const totalRegisteredCount = totalRegRow?.total_registered || 0;

  const [totalPresentRow] = await query(
    `SELECT COUNT(DISTINCT p.id) as total_present
     FROM passes p
     WHERE p.self_registration_id = ?
       AND (p.scan_count > 0 OR p.first_scanned_at IS NOT NULL OR EXISTS (
         SELECT 1 FROM scan_history sh WHERE sh.pass_id = p.id AND sh.result = 'approved'
       ))`,
    [selfReg.id]
  );
  const totalPresentCount = totalPresentRow?.total_present || 0;

  const listSql = `
    SELECT 
      p.id,
      p.code,
      p.customer_name,
      p.customer_email,
      p.customer_phone,
      p.photo_url,
      p.custom_fields_data,
      p.address,
      p.gender,
      p.age,
      p.status,
      p.scan_count,
      p.first_scanned_at,
      p.last_scanned_at,
      p.sharing_method,
      p.created_at,
      b.download_token
    FROM passes p
    LEFT JOIN billings b ON p.billing_id = b.id
    ${whereClause}
    ORDER BY p.id DESC
    LIMIT ? OFFSET ?
  `;

  const passes = await query(listSql, [...queryParams, pageLimit, offset]);

  // Fetch all active checkpoints for this event
  const checkpoints = await query(
    `SELECT id, name, code, checkpoint_type, start_time, end_time, display_order
     FROM scan_checkpoints
     WHERE event_id = ? AND is_active = TRUE
     ORDER BY display_order ASC, id ASC`,
    [selfReg.event_id]
  );

  // Per-checkpoint scan counts across ALL registered attendees for this registration
  const checkpointCountRows = await query(
    `SELECT sh.checkpoint_id, COUNT(DISTINCT sh.pass_id) as scanned_count
     FROM scan_history sh
     JOIN passes p ON sh.pass_id = p.id
     WHERE p.self_registration_id = ? AND sh.checkpoint_id IS NOT NULL AND sh.result = 'approved'
     GROUP BY sh.checkpoint_id`,
    [selfReg.id]
  );
  const checkpointCounts = {};
  for (const ccr of checkpointCountRows) {
    checkpointCounts[ccr.checkpoint_id] = Number(ccr.scanned_count) || 0;
  }

  // Fetch all operators who have scanned attendees for this registration
  const availableOperators = await query(
    `SELECT DISTINCT u.id, u.name, u.email
     FROM scan_history sh
     JOIN passes p ON sh.pass_id = p.id
     JOIN users u ON sh.operator_id = u.id
     WHERE p.self_registration_id = ? AND sh.result = 'approved'
     ORDER BY u.name ASC`,
    [selfReg.id]
  );

  // Fetch approved scans for these passes with operator details and scan sources
  const passIds = passes.map(p => p.id);
  const checkpointScansByPass = {};
  const latestScanByPass = {};

  if (passIds.length > 0) {
    const placeholders = passIds.map(() => '?').join(',');
    const scanRows = await query(
      `SELECT sh.id, sh.pass_id, sh.checkpoint_id, sh.scan_time, sh.operator_id,
              u.name as operator_name, u.email as operator_email,
              sh.scan_source, sh.device_id
       FROM scan_history sh
       LEFT JOIN users u ON sh.operator_id = u.id
       WHERE sh.pass_id IN (${placeholders}) AND sh.result = 'approved'
       ORDER BY sh.scan_time ASC, sh.id ASC`,
      passIds
    );

    for (const sr of scanRows) {
      if (sr.checkpoint_id) {
        if (!checkpointScansByPass[sr.pass_id]) {
          checkpointScansByPass[sr.pass_id] = {};
        }
        // First approved scan at this checkpoint
        if (!checkpointScansByPass[sr.pass_id][sr.checkpoint_id]) {
          checkpointScansByPass[sr.pass_id][sr.checkpoint_id] = {
            scanned: true,
            firstScanTime: sr.scan_time,
            firstScanTimeIST: formatDateTimeIST(sr.scan_time),
            operatorId: sr.operator_id,
            operatorName: sr.operator_name || 'Operator',
            operatorEmail: sr.operator_email || null,
            scanSource: sr.scan_source || 'camera',
            deviceId: sr.device_id
          };
        }
      }

      // Latest scan overall for this pass
      latestScanByPass[sr.pass_id] = {
        scanTime: sr.scan_time,
        scanTimeIST: formatDateTimeIST(sr.scan_time),
        operatorId: sr.operator_id,
        operatorName: sr.operator_name || 'Operator',
        operatorEmail: sr.operator_email || null,
        scanSource: sr.scan_source || 'camera',
        deviceId: sr.device_id
      };
    }
  }

  // Format passes with dynamic attendance tracking
  const formattedPasses = passes.map(p => {
    let customFieldsData = {};
    if (p.custom_fields_data) {
      try {
        customFieldsData = typeof p.custom_fields_data === 'string' ? JSON.parse(p.custom_fields_data) : p.custom_fields_data;
      } catch (_) {}
    }

    const scans = checkpointScansByPass[p.id] || {};
    const latest = latestScanByPass[p.id] || null;
    const hasAnyScan = (p.scan_count > 0) || Boolean(p.first_scanned_at) || Object.keys(scans).length > 0;

    const scannedBy = latest ? {
      id: latest.operatorId,
      name: latest.operatorName,
      email: latest.operatorEmail
    } : null;

    return {
      id: p.id,
      code: p.code,
      customerName: p.customer_name,
      customer_name: p.customer_name,
      customerEmail: p.customer_email,
      customer_email: p.customer_email,
      customerPhone: p.customer_phone,
      customer_phone: p.customer_phone,
      photoUrl: p.photo_url,
      photo_url: p.photo_url,
      customFieldsData,
      custom_fields_data: customFieldsData,
      address: p.address,
      gender: p.gender,
      age: p.age,
      status: p.status,
      scanCount: p.scan_count || 0,
      firstScannedAt: p.first_scanned_at,
      firstScannedAtIST: p.first_scanned_at ? formatDateTimeIST(p.first_scanned_at) : null,
      lastScannedAt: p.last_scanned_at,
      lastScannedAtIST: p.last_scanned_at ? formatDateTimeIST(p.last_scanned_at) : null,
      createdAt: p.created_at,
      downloadToken: p.download_token,
      checkpointScans: scans,
      scannedBy,
      scanSource: latest ? latest.scanSource : null,
      latestScan: latest,
      isPresent: hasAnyScan
    };
  });

  let customFields = [];
  if (selfReg.custom_fields) {
    try {
      customFields = typeof selfReg.custom_fields === 'string' ? JSON.parse(selfReg.custom_fields) : selfReg.custom_fields;
    } catch (_) {}
  }

  return {
    selfRegistration: {
      id: selfReg.id,
      title: selfReg.title,
      eventName: selfReg.event_name,
      categoryName: selfReg.category_name,
      totalIssued: totalRecords,
      totalRegistered: totalRegisteredCount,
      totalPresent: totalPresentCount
    },
    checkpoints: checkpoints.map(c => ({
      id: c.id,
      name: c.name,
      code: c.code,
      checkpointType: c.checkpoint_type,
      startTime: c.start_time,
      endTime: c.end_time,
      scannedCount: checkpointCounts[c.id] || 0
    })),
    availableOperators,
    customFields,
    passes: formattedPasses,
    pagination: {
      page: pageNum,
      limit: pageLimit,
      totalRecords,
      totalPages
    }
  };
}

/**
 * Public Customer View: Fetch configuration by publicToken
 * Validates link availability without leaking internal secrets
 */
async function getPublicRegistrationConfig(publicToken) {
  if (!publicToken || typeof publicToken !== 'string') {
    return {
      success: false,
      available: false,
      code: 'INVALID_TOKEN',
      message: 'Registration link is invalid.'
    };
  }

  const rows = await query(
    `SELECT 
      sr.id,
      sr.public_token,
      sr.title,
      sr.description,
      sr.status,
      sr.starts_at,
      sr.ends_at,
      sr.delivery_channel,
      sr.require_name,
      sr.require_phone,
      sr.require_email,
      sr.require_address,
      sr.require_gender,
      sr.require_age,
      sr.custom_fields,
      sr.max_registrations,
      sr.registration_count,
      e.id AS event_id,
      e.event_name,
      e.venue,
      e.event_start_date AS start_date,
      e.event_end_date AS end_date,
      c.id AS category_id,
      c.name AS category_name,
      c.code AS category_code,
      c.description AS category_description,
      c.price AS category_price,
      c.valid_from,
      c.valid_until,
      ps.name AS pass_style_name
    FROM self_registrations sr
    JOIN events e ON sr.event_id = e.id
    JOIN pass_categories c ON sr.category_id = c.id
    LEFT JOIN pass_styles ps ON sr.pass_style_id = ps.id
    WHERE sr.public_token = ?`,
    [publicToken.trim()]
  );

  if (!rows || rows.length === 0) {
    return {
      success: false,
      available: false,
      code: 'NOT_FOUND',
      message: 'Registration link is no longer available.'
    };
  }

  const config = rows[0];

  // 1. Check if Status is Active
  if (config.status !== 'ACTIVE') {
    return {
      success: false,
      available: false,
      code: 'LINK_DISABLED',
      message: 'Registration is currently closed for this event.'
    };
  }

  // 2. Check Active Time Window in IST
  const now = new Date();
  if (config.starts_at) {
    const startDate = new Date(config.starts_at);
    if (now < startDate) {
      return {
        success: false,
        available: false,
        code: 'NOT_OPENED',
        message: `Registration has not opened yet. It will open on ${formatDateTimeIST(config.starts_at)}.`,
        opensAt: config.starts_at
      };
    }
  }

  if (config.ends_at) {
    const endDate = new Date(config.ends_at);
    if (now > endDate) {
      return {
        success: false,
        available: false,
        code: 'EXPIRED',
        message: 'Registration for this event has closed.',
        closedAt: config.ends_at
      };
    }
  }

  // 3. Check Capacity
  if (config.max_registrations && config.registration_count >= config.max_registrations) {
    return {
      success: false,
      available: false,
      code: 'CAPACITY_REACHED',
      message: 'Registration capacity for this pass has been reached.'
    };
  }

  return {
    success: true,
    available: true,
    data: {
      publicToken: config.public_token,
      title: config.title,
      description: config.description,
      deliveryChannel: config.delivery_channel,
      fields: {
        requireName: Boolean(config.require_name),
        requirePhone: Boolean(config.require_phone || config.delivery_channel === 'WHATSAPP' || config.delivery_channel === 'BOTH'),
        requireEmail: Boolean(config.require_email || config.delivery_channel === 'EMAIL' || config.delivery_channel === 'BOTH'),
        requireAddress: Boolean(config.require_address),
        requireGender: Boolean(config.require_gender),
        requireAge: Boolean(config.require_age)
      },
      customFields: config.custom_fields ? (typeof config.custom_fields === 'string' ? JSON.parse(config.custom_fields) : config.custom_fields) : [],
      event: {
        name: config.event_name,
        venue: config.venue,
        startDate: config.start_date,
        endDate: config.end_date
      },
      category: {
        name: config.category_name,
        code: config.category_code,
        description: config.category_description,
        price: parseFloat(config.category_price || 0),
        validFrom: config.valid_from,
        validUntil: config.valid_until
      }
    }
  };
}

/**
 * Public Customer Submission: Self-Register and generate Pass
 * Atomic, idempotency-protected, applies exact pass style and delivery method
 */
async function registerCustomer(publicToken, formData, { ipAddress = null, userAgent = null, baseUrl = null } = {}) {
  if (!publicToken || typeof publicToken !== 'string') {
    throw createHttpError('Registration token is required', 400, 'INVALID_TOKEN');
  }

  const {
    name,
    phone,
    email,
    address,
    gender,
    age,
    customFieldsData,
    photoUrl
  } = formData || {};

  // 1. Fetch and validate registration configuration
  const rows = await query(
    `SELECT 
      sr.*,
      e.id AS event_id,
      e.event_name,
      e.venue,
      c.id AS category_id,
      c.name AS category_name,
      c.code AS category_code,
      c.category_prefix,
      c.price AS category_price,
      c.valid_from,
      c.valid_until,
      ps.id AS style_id,
      ps.name AS pass_style_name
    FROM self_registrations sr
    JOIN events e ON sr.event_id = e.id
    JOIN pass_categories c ON sr.category_id = c.id
    LEFT JOIN pass_styles ps ON sr.pass_style_id = ps.id
    WHERE sr.public_token = ?`,
    [publicToken.trim()]
  );

  if (!rows || rows.length === 0) {
    throw createHttpError('Registration link is no longer available.', 404, 'NOT_FOUND');
  }

  const selfReg = rows[0];

  if (selfReg.status !== 'ACTIVE') {
    throw createHttpError('Registration is currently closed for this event.', 403, 'REGISTRATION_CLOSED');
  }

  // Active Window check
  const now = new Date();
  if (selfReg.starts_at && now < new Date(selfReg.starts_at)) {
    throw createHttpError('Registration has not opened yet.', 403, 'REGISTRATION_NOT_STARTED');
  }
  if (selfReg.ends_at && now > new Date(selfReg.ends_at)) {
    throw createHttpError('Registration for this event has closed.', 403, 'REGISTRATION_EXPIRED');
  }

  // Capacity check
  if (selfReg.max_registrations && selfReg.registration_count >= selfReg.max_registrations) {
    throw createHttpError('Registration capacity for this pass has been reached.', 409, 'CAPACITY_REACHED');
  }

  // 2. Validate Customer Fields
  const cleanName = (name || '').trim();
  if (selfReg.require_name && cleanName.length < 2) {
    throw createHttpError('Full Name is required (minimum 2 characters).', 400, 'VALIDATION_ERROR');
  }

  const cleanPhone = normalizePhoneNumber(phone);
  const isPhoneMandatory = selfReg.require_phone || selfReg.delivery_channel === 'WHATSAPP' || selfReg.delivery_channel === 'BOTH';
  if (isPhoneMandatory && !cleanPhone) {
    throw createHttpError('A valid 10-digit mobile / WhatsApp number is required.', 400, 'VALIDATION_ERROR');
  }

  const cleanEmail = email && typeof email === 'string' ? email.trim().toLowerCase() : '';
  const isEmailMandatory = selfReg.require_email || selfReg.delivery_channel === 'EMAIL' || selfReg.delivery_channel === 'BOTH';
  if (isEmailMandatory && !isValidEmail(cleanEmail)) {
    throw createHttpError('A valid email address is required.', 400, 'VALIDATION_ERROR');
  }

  const cleanAddress = address && typeof address === 'string' ? address.trim() : null;
  if (selfReg.require_address && (!cleanAddress || cleanAddress.length < 3)) {
    throw createHttpError('Address is required.', 400, 'VALIDATION_ERROR');
  }

  const cleanGender = gender && typeof gender === 'string' ? gender.trim() : null;
  if (selfReg.require_gender && !cleanGender) {
    throw createHttpError('Gender is required.', 400, 'VALIDATION_ERROR');
  }

  const parsedAge = age !== undefined && age !== null && age !== '' ? parseInt(age, 10) : null;
  if (selfReg.require_age && (!parsedAge || parsedAge < 1 || parsedAge > 120)) {
    throw createHttpError('Please enter a valid age.', 400, 'VALIDATION_ERROR');
  }

  // Validate dynamic form fields configured for this registration
  if (selfReg.custom_fields) {
    try {
      const parsedFields = typeof selfReg.custom_fields === 'string' ? JSON.parse(selfReg.custom_fields) : selfReg.custom_fields;
      if (Array.isArray(parsedFields)) {
        for (const field of parsedFields) {
          if (field.required) {
            const val = customFieldsData ? (customFieldsData[field.id] !== undefined ? customFieldsData[field.id] : customFieldsData[field.label]) : null;
            if (field.type === 'image') {
              const imgVal = photoUrl || val;
              if (!imgVal) {
                throw createHttpError(`${field.label || 'Image upload'} is required.`, 400, 'VALIDATION_ERROR');
              }
            } else if (val === null || val === undefined || String(val).trim() === '' || (Array.isArray(val) && val.length === 0)) {
              throw createHttpError(`${field.label || 'Field'} is required.`, 400, 'VALIDATION_ERROR');
            }
          }
        }
      }
    } catch (e) {
      if (e.statusCode) throw e;
      if (e.message && e.message.includes('required')) throw createHttpError(e.message, 400, 'VALIDATION_ERROR');
    }
  }

  // Resolve attendee photo from direct upload or custom fields data
  let finalPhotoUrl = photoUrl || null;
  if (!finalPhotoUrl && customFieldsData) {
    for (const val of Object.values(customFieldsData)) {
      if (typeof val === 'string' && (val.startsWith('data:image') || val.startsWith('http://') || val.startsWith('https://') || val.startsWith('/uploads/'))) {
        finalPhotoUrl = val;
        break;
      }
    }
  }

  // Validate photo size & format if provided as base64 (<500 KB strictly enforced)
  if (finalPhotoUrl && typeof finalPhotoUrl === 'string' && finalPhotoUrl.startsWith('data:image')) {
    const mimeMatch = finalPhotoUrl.match(/^data:(image\/[a-zA-Z0-9\-\+\.]+);base64,/i);
    if (!mimeMatch) {
      throw createHttpError('Invalid image format. Supported formats: JPEG, PNG, WebP.', 400, 'INVALID_IMAGE');
    }
    const mime = mimeMatch[1].toLowerCase();
    if (!['image/jpeg', 'image/jpg', 'image/png', 'image/webp'].includes(mime)) {
      throw createHttpError(`Unsupported image format (${mime}). Allowed formats: JPG, PNG, WebP.`, 400, 'UNSUPPORTED_IMAGE_FORMAT');
    }
    const byteSize = getBase64ByteSize(finalPhotoUrl);
    if (byteSize > 500 * 1024) {
      throw createHttpError(`Uploaded image exceeds 500 KB limit (${Math.round(byteSize / 1024)} KB). Please compress or choose a smaller image.`, 400, 'IMAGE_TOO_LARGE');
    }
  }

  // Persist base64 photo to static uploads disk directory
  let storedPhotoUrl = finalPhotoUrl;
  if (finalPhotoUrl && typeof finalPhotoUrl === 'string' && finalPhotoUrl.startsWith('data:image')) {
    try {
      const savedPath = saveBase64Image(finalPhotoUrl, `attendee_${selfReg.id}`);
      if (savedPath) {
        storedPhotoUrl = savedPath;
      }
    } catch (saveErr) {
      console.warn('[Self Registration] Photo disk save error:', saveErr.message);
    }
  }

  // 3. Concurrency Lock & Idempotency Key
  const lockKey = `self_reg:${selfReg.id}:${cleanPhone || cleanEmail || cleanName}`;
  const lock = await acquireLock(lockKey, 10000);

  try {
    // 4. Duplicate Check (If allow_duplicate is FALSE)
    if (!selfReg.allow_duplicate) {
      const dupQueryParts = [];
      const dupParams = [selfReg.id];

      if (cleanPhone) {
        dupQueryParts.push('p.customer_phone = ?');
        dupParams.push(cleanPhone);
      }
      if (cleanEmail) {
        dupQueryParts.push('p.customer_email = ?');
        dupParams.push(cleanEmail);
      }

      if (dupQueryParts.length > 0) {
        const existingRows = await query(
          `SELECT p.*, b.download_token, b.bill_number
           FROM passes p
           LEFT JOIN billings b ON p.billing_id = b.id
           WHERE p.self_registration_id = ? 
             AND (${dupQueryParts.join(' OR ')})
             AND p.status != 'void'
           ORDER BY p.id DESC
           LIMIT 1`,
          dupParams
        );

        if (existingRows && existingRows.length > 0) {
          const existingPass = existingRows[0];
          console.log(`[Self Registration] Duplicate detected for ${cleanPhone || cleanEmail}. Returning existing pass: ${existingPass.code}`);

          const downloadToken = existingPass.download_token || generateSecureToken(16);
          const publicBaseUrl = (
            baseUrl ||
            process.env.PUBLIC_URL ||
            process.env.APP_BASE_URL ||
            process.env.VITE_API_URL ||
            'http://localhost:5006'
          ).replace(/\/+$/, '');

          const passPdfUrl = `${publicBaseUrl}/api/public/download/pass/${downloadToken}`;

          return {
            success: true,
            isExisting: true,
            message: 'You have already registered for this event! Here is your official pass.',
            pass: {
              id: existingPass.id,
              code: existingPass.code,
              customer_name: existingPass.customer_name,
              customer_email: existingPass.customer_email,
              customer_phone: existingPass.customer_phone,
              event_name: selfReg.event_name,
              venue: selfReg.venue,
              category_name: selfReg.category_name,
              category_code: selfReg.category_code,
              valid_from: existingPass.valid_from,
              valid_until: existingPass.valid_until,
              download_token: downloadToken
            },
            delivery: {
              channel: selfReg.delivery_channel,
              email_sent: false,
              whatsapp_ready: true,
              notes: 'Existing pass retrieved'
            },
            passPdfUrl,
            downloadUrl: `/api/public/download/pass/${downloadToken}`
          };
        }
      }
    }

    // 5. Fetch Pass Style (Use chosen style or event default)
    let style = null;
    if (selfReg.style_id) {
      const styleRows = await query('SELECT * FROM pass_styles WHERE id = ?', [selfReg.style_id]);
      if (styleRows && styleRows.length > 0) style = styleRows[0];
    }
    if (!style) {
      const defaultStyles = await query(
        'SELECT * FROM pass_styles WHERE (event_id = ? OR event_id IS NULL) ORDER BY is_default DESC, id ASC LIMIT 1',
        [selfReg.event_id]
      );
      if (defaultStyles && defaultStyles.length > 0) style = defaultStyles[0];
    }

    // 6. Execute Transaction: Create Billing + Pass + Increment registration_count
    const result = await withTransaction(async (conn) => {
      // Generate Invoice Number for Self-Registration
      const [lastBill] = await conn.query('SELECT MAX(id) as max_id FROM billings');
      const nextNum = (lastBill[0]?.max_id || 0) + 1;
      const billNumber = `SELF-${new Date().getFullYear()}-${String(nextNum).padStart(4, '0')}`;
      const downloadToken = generateSecureToken(16);

      const validSharingMethods = ['EMAIL', 'WHATSAPP', 'BOTH'];
      const sanitizedDeliveryChannel = validSharingMethods.includes(selfReg.delivery_channel) ? selfReg.delivery_channel : 'BOTH';

      const [billRes] = await conn.query(
        `INSERT INTO billings (
          bill_number, download_token, event_id, category_id, style_id,
          customer_name, customer_email, customer_phone,
          quantity, unit_price, subtotal, gst_mode, gst_rate, gst_amount, total_amount,
          is_complementary, include_pass_code_on_bill, sent_via, source, self_registration_id,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 0, 'OFF', 0, 0, 0, 1, 1, ?, 'SELF_REGISTRATION', ?, NOW())`,
        [
          billNumber,
          downloadToken,
          selfReg.event_id,
          selfReg.category_id,
          style?.id || null,
          cleanName,
          cleanEmail || null,
          cleanPhone || null,
          sanitizedDeliveryChannel,
          selfReg.id
        ]
      );

      const billingId = billRes.insertId;

      // Generate strictly unique 7-char pass code with HMAC
      const code = generatePassCode();
      const hmac = generateHmacSignature(code);

      const passValidFrom = selfReg.valid_from || new Date();
      const passValidUntil = selfReg.valid_until || new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
      const codeType = selfReg.category_code || 'GENERAL';
      const categoryPrefix = selfReg.category_prefix || '';

      const [passRes] = await conn.query(
        `INSERT INTO passes (
          event_id, category_id, code, code_type, category_prefix, hmac_sig,
          status, valid_from, valid_until, printed, billing_id, style_id,
          customer_name, customer_email, customer_phone, address, gender, age,
          photo_url, custom_fields_data,
          sharing_method, source, self_registration_id,
          first_shared_at, last_shared_at, reshare_count, created_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?,
          'active', ?, ?, false, ?, ?,
          ?, ?, ?, ?, ?, ?,
          ?, ?,
          ?, 'SELF_REGISTRATION', ?,
          NOW(), NOW(), 0, NOW()
        )`,
        [
          selfReg.event_id,
          selfReg.category_id,
          code,
          codeType,
          categoryPrefix,
          hmac,
          passValidFrom,
          passValidUntil,
          billingId,
          style?.id || null,
          cleanName,
          cleanEmail || null,
          cleanPhone || null,
          cleanAddress,
          cleanGender,
          parsedAge,
          storedPhotoUrl || finalPhotoUrl,
          customFieldsData ? JSON.stringify(customFieldsData) : null,
          sanitizedDeliveryChannel,
          selfReg.id
        ]
      );

      const passId = passRes.insertId;

      // Increment self registration count
      await conn.query('UPDATE self_registrations SET registration_count = registration_count + 1 WHERE id = ?', [selfReg.id]);

      // Increment category total quantity
      await conn.query('UPDATE pass_categories SET total_quantity = total_quantity + 1 WHERE id = ?', [selfReg.category_id]);

      // Audit Log (Safely truncated to prevent VARCHAR(255) overflows)
      try {
        const safeUserAgent = userAgent ? String(userAgent).substring(0, 255) : null;
        await conn.query(
          `INSERT INTO audit_log (event_id, user_id, user_name, action, entity, entity_id, new_value, ip_address, user_agent, created_at)
           VALUES (?, NULL, 'Self-Registered Customer', 'SELF_REGISTRATION_PASS_ISSUE', 'PASS', ?, ?, ?, ?, NOW())`,
          [
            selfReg.event_id,
            String(passId),
            JSON.stringify({
              selfRegistrationId: selfReg.id,
              passCode: code,
              customerName: cleanName,
              customerPhone: cleanPhone,
              customerEmail: cleanEmail,
              deliveryChannel: sanitizedDeliveryChannel
            }),
            ipAddress,
            safeUserAgent
          ]
        );
      } catch (auditErr) {
        console.warn('[Self Registration] Non-blocking audit log warning:', auditErr.message);
      }

      return {
        passId,
        code,
        hmac,
        billingId,
        billNumber,
        downloadToken
      };
    });

    // 7. Generate Pass PDF using the selected Pass Style
    let passPdfBuffer = null;
    try {
      passPdfBuffer = await generatePassPdf({
        style,
        pass: {
          code: result.code,
          code_type: selfReg.category_code,
          category_name: selfReg.category_name,
          customer_name: cleanName,
          photo_url: finalPhotoUrl,
          custom_fields_data: customFieldsData
        },
        event: { id: selfReg.event_id, event_name: selfReg.event_name, venue: selfReg.venue },
        category: {
          id: selfReg.category_id,
          name: selfReg.category_name,
          code: selfReg.category_code,
          valid_from: selfReg.valid_from,
          valid_until: selfReg.valid_until
        },
        customer: { name: cleanName, email: cleanEmail, phone: cleanPhone, photo_url: finalPhotoUrl }
      });
    } catch (pdfErr) {
      console.error('[Self Registration PDF Error]', pdfErr.message);
    }

    const publicBaseUrl = (
      baseUrl ||
      process.env.PUBLIC_URL ||
      process.env.APP_BASE_URL ||
      process.env.VITE_API_URL ||
      'http://localhost:5006'
    ).replace(/\/+$/, '');

    const passPdfUrl = `${publicBaseUrl}/api/public/download/pass/${result.downloadToken}`;

    // 8. Execute Delivery Channels (Email & WhatsApp as configured by Admin)
    let emailDelivery = { success: false, status: 'NOT_CONFIGURED' };
    if ((selfReg.delivery_channel === 'EMAIL' || selfReg.delivery_channel === 'BOTH') && cleanEmail) {
      try {
        const subject = `${selfReg.event_name} — Your Official Entry Pass (${result.code})`;
        const emailHtml = `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #1E293B; line-height: 1.6;">
            <div style="background-color: #0F172A; padding: 24px; text-align: center; border-radius: 8px 8px 0 0;">
              <h1 style="color: #FFFFFF; margin: 0; font-size: 22px;">${selfReg.event_name}</h1>
              <p style="color: #94A3B8; margin: 6px 0 0 0; font-size: 13px;">Official Pass Confirmation (Self Registration)</p>
            </div>
            <div style="padding: 24px; border: 1px solid #E2E8F0; border-top: none; background-color: #FFFFFF; border-radius: 0 0 8px 8px;">
              <p>Dear <strong>${cleanName}</strong>,</p>
              <p>Welcome! Your registration for <strong>${selfReg.event_name}</strong> is confirmed. Your official entry pass is attached to this email.</p>
              
              <div style="background-color: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 6px; padding: 16px; margin: 20px 0;">
                <table style="width: 100%; font-size: 13.5px;">
                  <tr><td style="color: #64748B;">Category:</td><td><strong>${selfReg.category_name}</strong></td></tr>
                  <tr><td style="color: #64748B;">Pass Code:</td><td style="font-family: monospace; font-weight: bold; color: #2563EB;">${result.code}</td></tr>
                  <tr><td style="color: #64748B;">Venue:</td><td><strong>${selfReg.venue || 'Event Venue'}</strong></td></tr>
                  <tr><td style="color: #64748B;">Status:</td><td><strong style="color: #047857;">CONFIRMED & ACTIVE</strong></td></tr>
                </table>
              </div>

              <div style="text-align: center; margin: 24px 0;">
                <a href="${passPdfUrl}" style="background-color: #4F46E5; color: #FFFFFF; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">
                  📥 Download Official Pass PDF
                </a>
              </div>

              <p style="font-size: 13px; color: #64748B;">
                <strong>Gate Instructions:</strong> Please present the scannable barcode/QR code on your pass at the entrance gate for quick verification.
              </p>

              <hr style="border: none; border-top: 1px solid #E2E8F0; margin: 24px 0;" />
              <p style="font-size: 11.5px; color: #94A3B8; text-align: center;">
                ${selfReg.event_name} • ${selfReg.venue || 'Event Venue'}<br />
                Automated Registration Delivery System
              </p>
            </div>
          </div>
        `;

        const attachments = passPdfBuffer ? [
          {
            filename: `Pass_${result.code}.pdf`,
            content: passPdfBuffer,
            contentType: 'application/pdf'
          }
        ] : [];

        emailDelivery = await eventDeliveryService.sendEventEmail({
          eventId: selfReg.event_id,
          billingId: result.billingId,
          to: cleanEmail,
          subject,
          html: emailHtml,
          attachments
        });
      } catch (emailErr) {
        console.error('[Self Registration Email Error]', emailErr.message);
        emailDelivery = { success: false, status: 'FAILED', error: emailErr.message };
      }
    }

    let whatsappDelivery = { success: false, status: 'NOT_CONFIGURED' };
    if ((selfReg.delivery_channel === 'WHATSAPP' || selfReg.delivery_channel === 'BOTH') && cleanPhone) {
      try {
        whatsappDelivery = await eventDeliveryService.generateEventWhatsappDelivery({
          eventId: selfReg.event_id,
          customerPhone: cleanPhone,
          customerName: cleanName,
          eventName: selfReg.event_name,
          passCodes: [result.code],
          totalAmount: 0,
          billingId: result.billingId,
          downloadToken: result.downloadToken,
          baseUrl,
          passPdfBuffer
        });
      } catch (waErr) {
        console.error('[Self Registration WhatsApp Error]', waErr.message);
        whatsappDelivery = { success: false, status: 'FAILED', error: waErr.message };
      }
    }

    // Record in pass_communication_history
    const historyStatus = (emailDelivery.status === 'SENT' || whatsappDelivery.status === 'READY') ? 'SENT' : 'READY';
    const validSharingMethods = ['EMAIL', 'WHATSAPP', 'BOTH'];
    const sanitizedDeliveryChannel = validSharingMethods.includes(selfReg.delivery_channel) ? selfReg.delivery_channel : 'BOTH';

    try {
      await query(
        `INSERT INTO pass_communication_history (
          pass_id, event_id, billing_id, customer_name, customer_email, customer_phone,
          sharing_method, status, shared_by, shared_by_name, notes, shared_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'Self-Registration Automated Delivery', 'Customer self-registered via public link', NOW(), NOW())`,
        [
          result.passId,
          selfReg.event_id,
          result.billingId,
          cleanName,
          cleanEmail || null,
          cleanPhone || null,
          sanitizedDeliveryChannel,
          historyStatus
        ]
      );
    } catch (historyErr) {
      console.warn('[Self Registration] Non-blocking communication history warning:', historyErr.message);
    }

    return {
      success: true,
      message: 'Registration successful! Your pass has been generated.',
      pass: {
        id: result.passId,
        code: result.code,
        customer_name: cleanName,
        customer_email: cleanEmail,
        customer_phone: cleanPhone,
        photo_url: finalPhotoUrl,
        photoUrl: finalPhotoUrl,
        custom_fields_data: customFieldsData,
        customFieldsData,
        event_name: selfReg.event_name,
        venue: selfReg.venue,
        category_name: selfReg.category_name,
        category_code: selfReg.category_code,
        valid_from: selfReg.valid_from,
        valid_until: selfReg.valid_until,
        download_token: result.downloadToken
      },
      delivery: {
        channel: selfReg.delivery_channel,
        email_sent: emailDelivery.status === 'SENT',
        email_status: emailDelivery.status,
        whatsapp_ready: whatsappDelivery.status === 'READY',
        whatsapp_url: whatsappDelivery.whatsappUrl || null
      },
      passPdfUrl,
      downloadUrl: `/api/public/download/pass/${result.downloadToken}`,
      whatsappUrl: whatsappDelivery.whatsappUrl || null
    };
  } finally {
    if (lock && typeof lock.release === 'function') {
      await lock.release();
    }
  }
}

module.exports = {
  createSelfRegistration,
  getSelfRegistrations,
  getSelfRegistrationById,
  updateSelfRegistration,
  toggleSelfRegistrationStatus,
  getSelfRegistrationAttendees,
  getPublicRegistrationConfig,
  registerCustomer
};
