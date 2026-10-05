const { query, withTransaction } = require('../config/db');
const { generatePassCode, generateHmacSignature, generateSecureToken } = require('../utils/cryptoUtil');
const { logAudit } = require('./AuditService');
const { generatePassPdf } = require('./pdfService');
const eventDeliveryService = require('./eventDeliveryService');
const { formatDateTimeIST, formatDateIST } = require('../utils/timeUtil');
const { acquireLock } = require('../config/redis');

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

  const result = await query(
    `INSERT INTO self_registrations (
      public_token, event_id, category_id, pass_style_id, title, description,
      status, starts_at, ends_at, delivery_channel,
      require_name, require_phone, require_email, require_address, require_gender, require_age,
      allow_duplicate, max_registrations, registration_count, created_by, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NOW())`,
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
    status
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
async function getSelfRegistrationAttendees(id, { eventId = null, isSuperAdmin = false, page = 1, limit = 20, search = '' } = {}) {
  const selfReg = await getSelfRegistrationById(id, { eventId, isSuperAdmin });

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const pageLimit = Math.min(100, Math.max(5, parseInt(limit, 10) || 20));
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

  const listSql = `
    SELECT 
      p.id,
      p.code,
      p.customer_name,
      p.customer_email,
      p.customer_phone,
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

  return {
    selfRegistration: {
      id: selfReg.id,
      title: selfReg.title,
      eventName: selfReg.event_name,
      categoryName: selfReg.category_name,
      totalIssued: totalRecords
    },
    passes,
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
    throw new Error('Registration token is required');
  }

  const {
    name,
    phone,
    email,
    address,
    gender,
    age
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
    throw new Error('Registration link is no longer available.');
  }

  const selfReg = rows[0];

  if (selfReg.status !== 'ACTIVE') {
    throw new Error('Registration is currently closed for this event.');
  }

  // Active Window check
  const now = new Date();
  if (selfReg.starts_at && now < new Date(selfReg.starts_at)) {
    throw new Error('Registration has not opened yet.');
  }
  if (selfReg.ends_at && now > new Date(selfReg.ends_at)) {
    throw new Error('Registration for this event has closed.');
  }

  // Capacity check
  if (selfReg.max_registrations && selfReg.registration_count >= selfReg.max_registrations) {
    throw new Error('Registration capacity for this pass has been reached.');
  }

  // 2. Validate Customer Fields
  const cleanName = (name || '').trim();
  if (selfReg.require_name && cleanName.length < 2) {
    throw new Error('Full Name is required (minimum 2 characters).');
  }

  const cleanPhone = normalizePhoneNumber(phone);
  const isPhoneMandatory = selfReg.require_phone || selfReg.delivery_channel === 'WHATSAPP' || selfReg.delivery_channel === 'BOTH';
  if (isPhoneMandatory && !cleanPhone) {
    throw new Error('A valid 10-digit mobile / WhatsApp number is required.');
  }

  const cleanEmail = email && typeof email === 'string' ? email.trim().toLowerCase() : '';
  const isEmailMandatory = selfReg.require_email || selfReg.delivery_channel === 'EMAIL' || selfReg.delivery_channel === 'BOTH';
  if (isEmailMandatory && !isValidEmail(cleanEmail)) {
    throw new Error('A valid email address is required.');
  }

  const cleanAddress = address && typeof address === 'string' ? address.trim() : null;
  if (selfReg.require_address && (!cleanAddress || cleanAddress.length < 3)) {
    throw new Error('Address is required.');
  }

  const cleanGender = gender && typeof gender === 'string' ? gender.trim() : null;
  if (selfReg.require_gender && !cleanGender) {
    throw new Error('Gender is required.');
  }

  const parsedAge = age !== undefined && age !== null && age !== '' ? parseInt(age, 10) : null;
  if (selfReg.require_age && (!parsedAge || parsedAge < 1 || parsedAge > 120)) {
    throw new Error('Please enter a valid age.');
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
          selfReg.delivery_channel,
          selfReg.id
        ]
      );

      const billingId = billRes.insertId;

      // Generate strictly unique 7-char pass code with HMAC
      const code = generatePassCode();
      const hmac = generateHmacSignature(code);

      const [passRes] = await conn.query(
        `INSERT INTO passes (
          event_id, category_id, code, code_type, category_prefix, hmac_sig,
          status, valid_from, valid_until, printed, billing_id, style_id,
          customer_name, customer_email, customer_phone, address, gender, age,
          sharing_method, source, self_registration_id,
          first_shared_at, last_shared_at, reshare_count, created_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?,
          'active', ?, ?, false, ?, ?,
          ?, ?, ?, ?, ?, ?,
          ?, 'SELF_REGISTRATION', ?,
          NOW(), NOW(), 0, NOW()
        )`,
        [
          selfReg.event_id,
          selfReg.category_id,
          code,
          selfReg.category_code,
          selfReg.category_prefix || '',
          hmac,
          selfReg.valid_from,
          selfReg.valid_until,
          billingId,
          style?.id || null,
          cleanName,
          cleanEmail || null,
          cleanPhone || null,
          cleanAddress,
          cleanGender,
          parsedAge,
          selfReg.delivery_channel,
          selfReg.id
        ]
      );

      const passId = passRes.insertId;

      // Increment self registration count
      await conn.query('UPDATE self_registrations SET registration_count = registration_count + 1 WHERE id = ?', [selfReg.id]);

      // Increment category total quantity
      await conn.query('UPDATE pass_categories SET total_quantity = total_quantity + 1 WHERE id = ?', [selfReg.category_id]);

      // Audit Log
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
            deliveryChannel: selfReg.delivery_channel
          }),
          ipAddress,
          userAgent
        ]
      );

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
          customer_name: cleanName
        },
        event: { id: selfReg.event_id, event_name: selfReg.event_name, venue: selfReg.venue },
        category: { id: selfReg.category_id, name: selfReg.category_name, code: selfReg.category_code },
        customer: { name: cleanName, email: cleanEmail, phone: cleanPhone }
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
        selfReg.delivery_channel,
        historyStatus
      ]
    );

    return {
      success: true,
      message: 'Registration successful! Your pass has been generated.',
      pass: {
        id: result.passId,
        code: result.code,
        customer_name: cleanName,
        customer_email: cleanEmail,
        customer_phone: cleanPhone,
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
