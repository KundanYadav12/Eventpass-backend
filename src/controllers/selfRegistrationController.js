const selfRegistrationService = require('../services/SelfRegistrationService');

function getBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.get('host') || 'localhost:5006';
  return process.env.PUBLIC_URL || process.env.APP_BASE_URL || `${proto}://${host}`;
}

async function create(req, res, next) {
  try {
    const isSuperAdmin = req.user?.role === 'SUPERADMIN' || req.user?.roleId === 1;
    const {
      eventId,
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
      customFields
    } = req.body;

    const assignedEventId = isSuperAdmin ? (eventId || req.effectiveEventId) : req.effectiveEventId;
    if (!assignedEventId) {
      return res.status(400).json({ success: false, message: 'Event ID is required' });
    }

    const result = await selfRegistrationService.createSelfRegistration({
      eventId: assignedEventId,
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
      customFields: customFields || null,
      userId: req.user?.id,
      userName: req.user?.name || 'Admin',
      ipAddress: req.ip || req.connection?.remoteAddress,
      userAgent: req.headers['user-agent']
    });

    res.status(201).json({
      success: true,
      message: 'Self Registration created successfully',
      data: result
    });
  } catch (error) {
    next(error);
  }
}

async function getAll(req, res, next) {
  try {
    const isSuperAdmin = req.user?.role === 'SUPERADMIN' || req.user?.roleId === 1;
    const eventId = isSuperAdmin ? (req.query.eventId || null) : req.effectiveEventId;
    const { search = '', status = 'all', page = 1, limit = 20 } = req.query;

    const result = await selfRegistrationService.getSelfRegistrations({
      eventId,
      isSuperAdmin,
      search,
      status,
      page,
      limit
    });

    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    next(error);
  }
}

async function getById(req, res, next) {
  try {
    const { id } = req.params;
    const isSuperAdmin = req.user?.role === 'SUPERADMIN' || req.user?.roleId === 1;
    const eventId = isSuperAdmin ? null : req.effectiveEventId;

    const result = await selfRegistrationService.getSelfRegistrationById(id, {
      eventId,
      isSuperAdmin
    });

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    next(error);
  }
}

async function update(req, res, next) {
  try {
    const { id } = req.params;
    const isSuperAdmin = req.user?.role === 'SUPERADMIN' || req.user?.roleId === 1;
    const eventId = isSuperAdmin ? null : req.effectiveEventId;

    const result = await selfRegistrationService.updateSelfRegistration(id, req.body, {
      eventId,
      isSuperAdmin,
      userId: req.user?.id,
      userName: req.user?.name || 'Admin',
      ipAddress: req.ip || req.connection?.remoteAddress,
      userAgent: req.headers['user-agent']
    });

    res.json({
      success: true,
      message: 'Self Registration updated successfully',
      data: result
    });
  } catch (error) {
    next(error);
  }
}

async function toggleStatus(req, res, next) {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const isSuperAdmin = req.user?.role === 'SUPERADMIN' || req.user?.roleId === 1;
    const eventId = isSuperAdmin ? null : req.effectiveEventId;

    const result = await selfRegistrationService.toggleSelfRegistrationStatus(id, {
      status,
      eventId,
      isSuperAdmin,
      userId: req.user?.id,
      userName: req.user?.name || 'Admin',
      ipAddress: req.ip || req.connection?.remoteAddress,
      userAgent: req.headers['user-agent']
    });

    res.json(result);
  } catch (error) {
    next(error);
  }
}

async function getAttendees(req, res, next) {
  try {
    const { id } = req.params;
    const isSuperAdmin = req.user?.role === 'SUPERADMIN' || req.user?.roleId === 1;
    const eventId = isSuperAdmin ? null : req.effectiveEventId;
    const { page = 1, limit = 20, search = '' } = req.query;

    const result = await selfRegistrationService.getSelfRegistrationAttendees(id, {
      eventId,
      isSuperAdmin,
      page,
      limit,
      search
    });

    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Public Endpoint: Get registration form configuration by public token
 */
async function getPublicConfig(req, res, next) {
  try {
    const { token } = req.params;
    const result = await selfRegistrationService.getPublicRegistrationConfig(token);

    if (!result.success) {
      const isNotFound = result.code === 'INVALID_TOKEN' || result.code === 'NOT_FOUND';
      return res.status(isNotFound ? 404 : 200).json(result);
    }

    res.json(result);
  } catch (error) {
    next(error);
  }
}

/**
 * Public Endpoint: Customer Self-Registration Submission
 */
async function submitRegistration(req, res, next) {
  try {
    const { token } = req.params;
    const baseUrl = getBaseUrl(req);

    const result = await selfRegistrationService.registerCustomer(token, req.body, {
      ipAddress: req.ip || req.connection?.remoteAddress,
      userAgent: req.headers['user-agent'],
      baseUrl
    });

    res.status(200).json(result);
  } catch (error) {
    console.error(`[Self Registration Submit Error] Token: ${req.params?.token}:`, error.message);
    const statusCode = error.statusCode || 400;
    res.status(statusCode).json({
      success: false,
      message: error.message || 'Registration failed. Please check your details and try again.',
      code: error.code || 'REGISTRATION_ERROR'
    });
  }
}

module.exports = {
  create,
  getAll,
  getById,
  update,
  toggleStatus,
  getAttendees,
  getPublicConfig,
  submitRegistration
};
