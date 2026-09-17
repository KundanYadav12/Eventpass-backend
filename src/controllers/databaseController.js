const databaseService = require('../services/DatabaseService');

async function getTables(req, res, next) {
  try {
    const tables = await databaseService.getDiscoveredTables();
    res.json({
      success: true,
      data: tables,
      count: tables.length
    });
  } catch (error) {
    next(error);
  }
}

async function getTableSchema(req, res, next) {
  try {
    const { table } = req.params;
    const schema = await databaseService.getTableSchema(table);
    res.json({
      success: true,
      data: schema
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    next(error);
  }
}

async function getTableRecords(req, res, next) {
  try {
    const { table } = req.params;
    const { page, limit, search, sortBy, sortDir } = req.query;

    let filters = {};
    if (req.query.filters) {
      if (typeof req.query.filters === 'string') {
        try {
          filters = JSON.parse(req.query.filters);
        } catch (e) {
          filters = {};
        }
      } else if (typeof req.query.filters === 'object') {
        filters = req.query.filters;
      }
    }

    // Support fc_<colName>=<value> style query parameters
    for (const [key, val] of Object.entries(req.query)) {
      if (key.startsWith('fc_') && val !== undefined && val !== '') {
        filters[key.slice(3)] = val;
      }
    }

    const result = await databaseService.getTableRecords(table, {
      page,
      limit,
      search,
      sortBy,
      sortDir,
      filters
    });

    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    next(error);
  }
}

async function getColumnDistinctValues(req, res, next) {
  try {
    const { table, column } = req.params;
    const { limit } = req.query;

    const result = await databaseService.getColumnDistinctValues(table, column, { limit });

    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    next(error);
  }
}

async function getRecordById(req, res, next) {
  try {
    const { table, id } = req.params;
    const result = await databaseService.getRecordById(table, id);
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    next(error);
  }
}

async function updateRecord(req, res, next) {
  try {
    const { table, id } = req.params;
    const { updates = {}, confirmCriticalChange = false } = req.body;

    const auditUser = {
      id: req.user?.id,
      name: req.user?.name,
      email: req.user?.email,
      ip: req.ip || req.connection.remoteAddress,
      userAgent: req.headers['user-agent']
    };

    const result = await databaseService.updateRecord(table, id, {
      updates,
      confirmCriticalChange
    }, auditUser);

    res.json(result);
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({
        success: false,
        message: error.message,
        criticalFields: error.criticalFields || null,
        requiresConfirmation: Boolean(error.requiresConfirmation)
      });
    }
    next(error);
  }
}

async function deleteRecord(req, res, next) {
  try {
    const { table, id } = req.params;
    const { confirmDelete = false, confirmationText = '' } = req.body;

    const auditUser = {
      id: req.user?.id,
      name: req.user?.name,
      email: req.user?.email,
      ip: req.ip || req.connection.remoteAddress,
      userAgent: req.headers['user-agent']
    };

    const result = await databaseService.deleteRecord(table, id, {
      confirmDelete,
      confirmationText
    }, auditUser);

    res.json(result);
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({
        success: false,
        message: error.message
      });
    }
    next(error);
  }
}

module.exports = {
  getTables,
  getTableSchema,
  getTableRecords,
  getColumnDistinctValues,
  getRecordById,
  updateRecord,
  deleteRecord
};
