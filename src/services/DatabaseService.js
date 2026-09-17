const { query, dbConfig } = require('../config/db');
const { logAudit } = require('./AuditService');

// Critical production tables where deletion is permanently forbidden
const PROTECTED_DELETE_TABLES = [
  'passes',
  'audit_log',
  'events',
  'scan_history',
  'billings',
  'pass_categories',
  'roles',
  'permissions',
  'role_permissions',
  'admin_event_permissions'
];

// Sensitive columns that must be masked by default
const SENSITIVE_COLUMN_PATTERNS = [
  'password',
  'password_hash',
  'token',
  'refresh_token',
  'access_token',
  'secret',
  'secret_key',
  'email_pass',
  'smtp_pass',
  'webhook_secret'
];

// Critical columns that warrant explicit confirmation before modifying
const CRITICAL_COLUMNS = [
  'pass_code',
  'barcode_value',
  'qr_code_value',
  'category_id',
  'event_id',
  'price',
  'total_amount',
  'transaction_id',
  'bill_number',
  'scan_count',
  'role_id'
];

/**
 * Fetch all discovered tables strictly from the active application database
 */
async function getDiscoveredTables() {
  const currentDb = dbConfig.database;
  const rows = await query(
    `SELECT TABLE_NAME, TABLE_ROWS, DATA_LENGTH, INDEX_LENGTH, CREATE_TIME, UPDATE_TIME, ENGINE, TABLE_COLLATION, TABLE_COMMENT
     FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = ?
     ORDER BY TABLE_NAME ASC`,
    [currentDb]
  );

  return rows.map(r => ({
    name: r.TABLE_NAME,
    approxRowCount: r.TABLE_ROWS || 0,
    dataLengthBytes: r.DATA_LENGTH || 0,
    indexLengthBytes: r.INDEX_LENGTH || 0,
    createTime: r.CREATE_TIME,
    updateTime: r.UPDATE_TIME,
    engine: r.ENGINE || 'InnoDB',
    collation: r.TABLE_COLLATION || 'utf8mb4_unicode_ci',
    comment: r.TABLE_COMMENT || '',
    isDeleteProtected: PROTECTED_DELETE_TABLES.includes(r.TABLE_NAME)
  }));
}

/**
 * Verify a table name exists in the active database allowlist
 */
async function validateTableName(tableName) {
  if (!tableName || typeof tableName !== 'string') {
    throw new Error('Invalid table name provided');
  }

  const cleanName = tableName.trim();
  const currentDb = dbConfig.database;

  const rows = await query(
    'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? LIMIT 1',
    [currentDb, cleanName]
  );

  if (rows.length === 0) {
    const error = new Error(`Table '${cleanName}' not found in application database`);
    error.statusCode = 404;
    throw error;
  }

  return cleanName;
}

/**
 * Fetch schema/structure metadata for a validated table
 */
async function getTableSchema(tableName) {
  const validTable = await validateTableName(tableName);
  const currentDb = dbConfig.database;

  // 1. Column metadata
  const columns = await query(
    `SELECT COLUMN_NAME, COLUMN_TYPE, DATA_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT, EXTRA, COLUMN_COMMENT
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
     ORDER BY ORDINAL_POSITION ASC`,
    [currentDb, validTable]
  );

  // 2. Index metadata
  const indexes = await query(
    `SELECT INDEX_NAME, COLUMN_NAME, NON_UNIQUE, SEQ_IN_INDEX, INDEX_TYPE
     FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
     ORDER BY INDEX_NAME ASC, SEQ_IN_INDEX ASC`,
    [currentDb, validTable]
  );

  // 3. Exact record count
  const [countRes] = await query(`SELECT COUNT(*) as exactCount FROM \`${validTable}\``);
  const exactCount = countRes ? countRes.exactCount : 0;

  // Determine primary key column(s)
  const pkCols = columns.filter(c => c.COLUMN_KEY === 'PRI').map(c => c.COLUMN_NAME);
  const primaryKey = pkCols.length > 0 ? pkCols[0] : (columns[0] ? columns[0].COLUMN_NAME : 'id');

  const formattedCols = columns.map(c => {
    const colLower = c.COLUMN_NAME.toLowerCase();
    const isSensitive = SENSITIVE_COLUMN_PATTERNS.some(pat => colLower.includes(pat));
    const isCritical = CRITICAL_COLUMNS.includes(colLower);

    return {
      name: c.COLUMN_NAME,
      type: c.COLUMN_TYPE,
      dataType: c.DATA_TYPE,
      isNullable: c.IS_NULLABLE === 'YES',
      columnKey: c.COLUMN_KEY,
      defaultValue: c.COLUMN_DEFAULT,
      extra: c.EXTRA,
      comment: c.COLUMN_COMMENT,
      isPrimaryKey: c.COLUMN_KEY === 'PRI',
      isSensitive,
      isCritical
    };
  });

  return {
    tableName: validTable,
    exactCount,
    primaryKey,
    primaryKeyColumns: pkCols,
    isDeleteProtected: PROTECTED_DELETE_TABLES.includes(validTable),
    columns: formattedCols,
    indexes: indexes.map(idx => ({
      indexName: idx.INDEX_NAME,
      columnName: idx.COLUMN_NAME,
      isUnique: idx.NON_UNIQUE === 0,
      seqInIndex: idx.SEQ_IN_INDEX,
      type: idx.INDEX_TYPE
    }))
  };
}

/**
 * Fetch records with server-side pagination, search & sorting
 */
async function getTableRecords(tableName, {
  page = 1,
  limit = 25,
  search = '',
  sortBy = '',
  sortDir = 'ASC',
  filters = {}
} = {}) {
  const schema = await getTableSchema(tableName);
  const validTable = schema.tableName;

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(5, parseInt(limit, 10) || 25));
  const offset = (pageNum - 1) * limitNum;

  // Validate sort column against table columns
  let orderCol = schema.primaryKey;
  if (sortBy && schema.columns.some(c => c.name === sortBy)) {
    orderCol = sortBy;
  }

  const cleanSortDir = String(sortDir).toUpperCase() === 'DESC' ? 'DESC' : 'ASC';

  // Construct parameterized search clause
  const whereClauses = [];
  const queryParams = [];

  if (search && search.trim()) {
    const searchVal = `%${search.trim()}%`;
    const textCols = schema.columns.filter(c =>
      ['varchar', 'char', 'text', 'mediumtext', 'longtext', 'int', 'bigint', 'decimal'].includes(c.dataType.toLowerCase())
    );

    if (textCols.length > 0) {
      const colMatches = textCols.map(c => `\`${c.name}\` LIKE ?`).join(' OR ');
      whereClauses.push(`(${colMatches})`);
      textCols.forEach(() => queryParams.push(searchVal));
    }
  }

  // Construct column-specific filter clauses
  if (filters && typeof filters === 'object') {
    for (const [colName, colVal] of Object.entries(filters)) {
      const colDef = schema.columns.find(c => c.name === colName);
      if (!colDef) continue;
      if (colVal === undefined || colVal === null || colVal === '') continue;

      if (colVal === '__NULL__') {
        whereClauses.push(`\`${colDef.name}\` IS NULL`);
      } else if (colVal === '__NOT_NULL__') {
        whereClauses.push(`\`${colDef.name}\` IS NOT NULL`);
      } else if (colVal === '__EMPTY__') {
        whereClauses.push(`\`${colDef.name}\` = ''`);
      } else {
        whereClauses.push(`\`${colDef.name}\` = ?`);
        queryParams.push(colVal);
      }
    }
  }

  const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

  // Get total count matching filter
  const [totalRes] = await query(
    `SELECT COUNT(*) as filteredCount FROM \`${validTable}\` ${whereSql}`,
    queryParams
  );
  const total = totalRes ? totalRes.filteredCount : 0;
  const totalPages = Math.ceil(total / limitNum) || 1;

  // Query records with pagination
  const records = await query(
    `SELECT * FROM \`${validTable}\` ${whereSql} ORDER BY \`${orderCol}\` ${cleanSortDir} LIMIT ? OFFSET ?`,
    [...queryParams, limitNum, offset]
  );

  // Mask sensitive columns in returned dataset
  const safeRecords = records.map(record => {
    const copy = { ...record };
    schema.columns.forEach(col => {
      if (col.isSensitive && copy[col.name] !== null && copy[col.name] !== undefined) {
        copy[col.name] = '••••••••';
      }
    });
    return copy;
  });

  return {
    tableName: validTable,
    primaryKey: schema.primaryKey,
    isDeleteProtected: schema.isDeleteProtected,
    columns: schema.columns,
    records: safeRecords,
    activeFilters: filters,
    pagination: {
      page: pageNum,
      limit: limitNum,
      total,
      totalPages,
      sortBy: orderCol,
      sortDir: cleanSortDir
    }
  };
}

/**
 * Fetch distinct unique values for a specific table column
 */
async function getColumnDistinctValues(tableName, columnName, { limit = 200 } = {}) {
  const schema = await getTableSchema(tableName);
  const validTable = schema.tableName;

  const colDef = schema.columns.find(c => c.name === columnName);
  if (!colDef) {
    const error = new Error(`Column '${columnName}' does not exist in table '${validTable}'`);
    error.statusCode = 400;
    throw error;
  }

  // Protect sensitive columns (e.g. password_hash, tokens)
  if (colDef.isSensitive) {
    return {
      tableName: validTable,
      columnName: colDef.name,
      dataType: colDef.dataType,
      hasNull: false,
      hasEmpty: false,
      values: []
    };
  }

  const safeCol = `\`${colDef.name}\``;
  const maxLimit = Math.min(500, Math.max(10, parseInt(limit, 10) || 200));

  // Query distinct non-null values
  const rows = await query(
    `SELECT DISTINCT ${safeCol} AS val FROM \`${validTable}\` WHERE ${safeCol} IS NOT NULL ORDER BY ${safeCol} ASC LIMIT ?`,
    [maxLimit]
  );

  // Check if NULL values exist in this column
  const [nullCheck] = await query(
    `SELECT 1 FROM \`${validTable}\` WHERE ${safeCol} IS NULL LIMIT 1`
  );
  const hasNull = Boolean(nullCheck);

  // Format values safely
  const values = [];
  let hasEmpty = false;

  rows.forEach(r => {
    const v = r.val;
    if (v === '') {
      hasEmpty = true;
    } else if (v instanceof Date) {
      values.push(v.toISOString());
    } else {
      values.push(v);
    }
  });

  return {
    tableName: validTable,
    columnName: colDef.name,
    dataType: colDef.dataType,
    hasNull,
    hasEmpty,
    values
  };
}

/**
 * Fetch a single unmasked record for detail inspection
 */
async function getRecordById(tableName, id) {
  const schema = await getTableSchema(tableName);
  const validTable = schema.tableName;
  const pkCol = schema.primaryKey;

  const rows = await query(
    `SELECT * FROM \`${validTable}\` WHERE \`${pkCol}\` = ? LIMIT 1`,
    [id]
  );

  if (rows.length === 0) {
    const error = new Error(`Record #${id} not found in table '${validTable}'`);
    error.statusCode = 404;
    throw error;
  }

  const record = rows[0];
  // Mask sensitive values
  const safeRecord = { ...record };
  schema.columns.forEach(col => {
    if (col.isSensitive && safeRecord[col.name] !== null && safeRecord[col.name] !== undefined) {
      safeRecord[col.name] = '•••••••• [MASKED SECRET]';
    }
  });

  return {
    tableName: validTable,
    primaryKey: pkCol,
    columns: schema.columns,
    record: safeRecord,
    rawValues: record // internal reference if needed
  };
}

/**
 * Controlled update of a single table record with before/after audit logging
 */
async function updateRecord(tableName, id, { updates = {}, confirmCriticalChange = false }, auditUser = {}) {
  const schema = await getTableSchema(tableName);
  const validTable = schema.tableName;
  const pkCol = schema.primaryKey;

  // 1. Fetch current record
  const existingRows = await query(
    `SELECT * FROM \`${validTable}\` WHERE \`${pkCol}\` = ? LIMIT 1`,
    [id]
  );

  if (existingRows.length === 0) {
    const error = new Error(`Record #${id} not found in table '${validTable}'`);
    error.statusCode = 404;
    throw error;
  }

  const currentRecord = existingRows[0];

  // 2. Validate update keys against table columns
  const validColNames = schema.columns.map(c => c.name);
  const setClauses = [];
  const setParams = [];
  const oldDiff = {};
  const newDiff = {};
  const modifiedCriticalFields = [];

  for (const [key, val] of Object.entries(updates)) {
    // Skip primary key or non-existent columns
    if (key === pkCol || !validColNames.includes(key)) {
      continue;
    }

    const colMeta = schema.columns.find(c => c.name === key);

    // Safeguard password hashes: do not allow raw unhashed strings directly
    if (key === 'password_hash' && typeof val === 'string' && !val.startsWith('$2')) {
      throw new Error('Directly modifying password_hash with plaintext is forbidden. Use User Management to reset passwords.');
    }

    // Check if value actually changed
    const currentVal = currentRecord[key];
    const isDifferent = String(currentVal) !== String(val);

    if (isDifferent) {
      if (colMeta && colMeta.isCritical) {
        modifiedCriticalFields.push({
          column: key,
          oldValue: currentVal,
          newValue: val
        });
      }

      setClauses.push(`\`${key}\` = ?`);
      setParams.push(val === '' && colMeta.isNullable ? null : val);
      oldDiff[key] = currentVal;
      newDiff[key] = val;
    }
  }

  if (setClauses.length === 0) {
    return {
      success: true,
      message: 'No changes detected',
      record: currentRecord
    };
  }

  // 3. Critical Production Field Safeguard
  if (modifiedCriticalFields.length > 0 && !confirmCriticalChange) {
    const error = new Error(
      `Critical production fields [${modifiedCriticalFields.map(f => f.column).join(', ')}] are being modified. Explicit confirmation required.`
    );
    error.statusCode = 400;
    error.criticalFields = modifiedCriticalFields;
    error.requiresConfirmation = true;
    throw error;
  }

  // 4. Execute Update
  setParams.push(id);
  await query(
    `UPDATE \`${validTable}\` SET ${setClauses.join(', ')} WHERE \`${pkCol}\` = ?`,
    setParams
  );

  // 5. Write to Audit Log
  await logAudit({
    userId: auditUser.id || null,
    userName: auditUser.name || auditUser.email || 'SuperAdmin',
    action: 'DATABASE_EDIT_RECORD',
    entity: validTable,
    entityId: `${id}`,
    oldValue: oldDiff,
    newValue: newDiff,
    ipAddress: auditUser.ip || null,
    userAgent: auditUser.userAgent || null
  });

  // 6. Fetch updated record
  const [updatedRecord] = await query(
    `SELECT * FROM \`${validTable}\` WHERE \`${pkCol}\` = ?`,
    [id]
  );

  return {
    success: true,
    message: `Record #${id} in table '${validTable}' successfully updated`,
    tableName: validTable,
    recordId: id,
    changesCount: setClauses.length,
    modifiedFields: Object.keys(newDiff),
    record: updatedRecord
  };
}

/**
 * Delete a single record if table is not delete-protected
 */
async function deleteRecord(tableName, id, { confirmDelete = false, confirmationText = '' } = {}, auditUser = {}) {
  const schema = await getTableSchema(tableName);
  const validTable = schema.tableName;
  const pkCol = schema.primaryKey;

  // 1. Permanent protection for production-critical tables
  if (schema.isDeleteProtected) {
    const error = new Error(
      `Deletion is permanently disabled for production table '${validTable}' to safeguard platform integrity.`
    );
    error.statusCode = 403;
    throw error;
  }

  // 2. Explicit confirmation check
  if (!confirmDelete || confirmationText !== validTable) {
    const error = new Error(
      `Deletion requires explicit confirmation. Please confirm with the table name '${validTable}'.`
    );
    error.statusCode = 400;
    throw error;
  }

  // 3. Fetch existing record
  const rows = await query(`SELECT * FROM \`${validTable}\` WHERE \`${pkCol}\` = ? LIMIT 1`, [id]);
  if (rows.length === 0) {
    const error = new Error(`Record #${id} not found in table '${validTable}'`);
    error.statusCode = 404;
    throw error;
  }

  // 4. Delete record
  await query(`DELETE FROM \`${validTable}\` WHERE \`${pkCol}\` = ?`, [id]);

  // 5. Audit Log
  await logAudit({
    userId: auditUser.id || null,
    userName: auditUser.name || auditUser.email || 'SuperAdmin',
    action: 'DATABASE_DELETE_RECORD',
    entity: validTable,
    entityId: `${id}`,
    oldValue: rows[0],
    newValue: null,
    ipAddress: auditUser.ip || null,
    userAgent: auditUser.userAgent || null
  });

  return {
    success: true,
    message: `Record #${id} successfully deleted from '${validTable}'`
  };
}

module.exports = {
  getDiscoveredTables,
  getTableSchema,
  getTableRecords,
  getColumnDistinctValues,
  getRecordById,
  updateRecord,
  deleteRecord
};
