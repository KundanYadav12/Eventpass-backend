const ExcelJS = require('exceljs');
const { query } = require('../config/db');
const {
  formatDateTimeIST,
  formatDateIST,
  formatTimeIST,
  getISTPresetRangeUTC,
  getISTDateRangeBoundsUTC,
  getISTComponents
} = require('../utils/timeUtil');

/**
 * Build SQL WHERE conditions for sales queries
 */
function buildSalesWhere({
  eventId = null,
  categoryId = null,
  datePreset = 'all',
  dateFrom = null,
  dateTo = null,
  search = '',
  paymentStatus = '',
  sharingMethod = '',
  passStatus = '',
  createdBy = null
}) {
  const whereConditions = [];
  const queryParams = [];

  // Scoped by event_id
  if (eventId) {
    whereConditions.push('b.event_id = ?');
    queryParams.push(parseInt(eventId, 10));
  }

  // Scoped by category_id
  if (categoryId && categoryId !== 'all') {
    whereConditions.push('b.category_id = ?');
    queryParams.push(parseInt(categoryId, 10));
  }

  // Date Range filter (strictly in IST)
  if (datePreset && datePreset !== 'all') {
    const { startUtc, endUtc } = getISTPresetRangeUTC(datePreset, dateFrom, dateTo);
    if (startUtc) {
      whereConditions.push('b.created_at >= ?');
      queryParams.push(startUtc);
    }
    if (endUtc) {
      whereConditions.push('b.created_at <= ?');
      queryParams.push(endUtc);
    }
  } else if (dateFrom || dateTo) {
    const { startUtc, endUtc } = getISTDateRangeBoundsUTC(dateFrom, dateTo);
    if (startUtc) {
      whereConditions.push('b.created_at >= ?');
      queryParams.push(startUtc);
    }
    if (endUtc) {
      whereConditions.push('b.created_at <= ?');
      queryParams.push(endUtc);
    }
  }

  // Search by customer name, email, phone, bill number, sponsor
  if (search && search.trim()) {
    const s = `%${search.trim()}%`;
    whereConditions.push('(b.customer_name LIKE ? OR b.customer_email LIKE ? OR b.customer_phone LIKE ? OR b.bill_number LIKE ? OR b.sponsor_name LIKE ? OR p.code LIKE ?)');
    queryParams.push(s, s, s, s, s, s);
  }

  // Filter by Sharing Method
  if (sharingMethod && sharingMethod !== 'all') {
    whereConditions.push('b.sent_via = ?');
    queryParams.push(sharingMethod);
  }

  // Filter by Pass Status (e.g. active, used, void, expired)
  if (passStatus && passStatus !== 'all') {
    whereConditions.push('p.status = ?');
    queryParams.push(passStatus);
  }

  // Filter by Created By
  if (createdBy && createdBy !== 'all') {
    whereConditions.push('b.created_by = ?');
    queryParams.push(parseInt(createdBy, 10));
  }

  return {
    whereClause: whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '',
    queryParams
  };
}

/**
 * Get comprehensive Sales Report Summary KPIs
 */
async function getSalesSummary(filters) {
  const { whereClause, queryParams } = buildSalesWhere(filters);

  // Aggregation on billings table
  const summarySql = `
    SELECT
      COUNT(DISTINCT b.id) as total_invoices,
      COALESCE(SUM(b.quantity), 0) as total_passes_sold,
      COALESCE(SUM(CASE WHEN b.is_complementary = 1 OR b.total_amount = 0 THEN b.quantity ELSE 0 END), 0) as total_complementary_passes,
      COALESCE(SUM(b.subtotal), 0) as total_subtotal,
      COALESCE(SUM(b.gst_amount), 0) as total_gst,
      COALESCE(SUM(b.total_amount), 0) as total_gross_sales,
      COUNT(DISTINCT CASE 
        WHEN b.customer_email IS NOT NULL AND b.customer_email != '' THEN b.customer_email 
        WHEN b.customer_phone IS NOT NULL AND b.customer_phone != '' THEN b.customer_phone 
        ELSE b.customer_name 
      END) as total_customers
    FROM billings b
    LEFT JOIN passes p ON p.billing_id = b.id
    LEFT JOIN pass_categories c ON b.category_id = c.id
    ${whereClause}
  `;

  const [summaryRes] = await query(summarySql, queryParams);

  // Count voided/refunded passes matching filters
  const voidSql = `
    SELECT COUNT(*) as total_voided
    FROM passes p
    JOIN billings b ON p.billing_id = b.id
    LEFT JOIN pass_categories c ON b.category_id = c.id
    ${whereClause ? whereClause + ' AND p.status = "void"' : 'WHERE p.status = "void"'}
  `;
  const [voidRes] = await query(voidSql, queryParams);

  const totalPasses = Number(summaryRes?.total_passes_sold || 0);
  const grossSales = Number(summaryRes?.total_gross_sales || 0);
  const totalGst = Number(summaryRes?.total_gst || 0);
  const totalSubtotal = Number(summaryRes?.total_subtotal || 0);
  const avgPassValue = totalPasses > 0 ? grossSales / totalPasses : 0;

  return {
    totalInvoices: Number(summaryRes?.total_invoices || 0),
    totalPassesSold: totalPasses,
    totalComplementaryPasses: Number(summaryRes?.total_complementary_passes || 0),
    totalSalesAmount: grossSales,
    totalGst: totalGst,
    totalDiscount: 0.00,
    netRevenue: grossSales,
    totalSubtotal: totalSubtotal,
    averagePassValue: Math.round(avgPassValue * 100) / 100,
    totalCustomers: Number(summaryRes?.total_customers || 0),
    totalVoidedPasses: Number(voidRes?.total_voided || 0)
  };
}

/**
 * Get paginated sales ledger / transactions list
 */
async function getSalesTransactions(filters) {
  const { page = 1, limit = 20, sortBy = 'id', sortDir = 'DESC' } = filters;
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const pageLimit = Math.min(100, Math.max(5, parseInt(limit, 10) || 20));
  const offset = (pageNum - 1) * pageLimit;

  const { whereClause, queryParams } = buildSalesWhere(filters);

  // Count total records
  const countSql = `
    SELECT COUNT(*) as total
    FROM passes p
    JOIN billings b ON p.billing_id = b.id
    JOIN events e ON b.event_id = e.id
    JOIN pass_categories c ON b.category_id = c.id
    ${whereClause}
  `;
  const [countRes] = await query(countSql, queryParams);
  const totalRecords = countRes?.total || 0;
  const totalPages = Math.ceil(totalRecords / pageLimit);

  const allowedSorts = [
    'id', 'created_at', 'total_amount', 'customer_name', 'code',
    'category_name', 'event_name', 'status', 'scan_count', 'bill_number'
  ];
  const safeSortBy = allowedSorts.includes(sortBy) ? (sortBy === 'created_at' ? 'b.created_at' : `p.${sortBy}`) : 'b.id';
  const safeSortDir = sortDir.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

  const dataSql = `
    SELECT
      p.id as pass_id,
      p.code as pass_code,
      p.status as pass_status,
      p.scan_count,
      p.first_scanned_at,
      p.last_scanned_at,
      p.first_shared_at,
      p.last_shared_at,
      p.reshare_count,
      p.sharing_method as pass_sharing_method,
      p.created_at as pass_created_at,
      b.id as billing_id,
      b.bill_number,
      b.download_token,
      b.customer_name,
      b.customer_email,
      b.customer_phone,
      b.sponsor_name,
      b.quantity as billing_quantity,
      b.unit_price,
      b.subtotal as billing_subtotal,
      b.gst_mode,
      b.gst_rate,
      b.gst_amount as billing_gst,
      b.total_amount as billing_total,
      b.sent_via as billing_sent_via,
      b.created_at as sale_date,
      e.id as event_id,
      e.event_name,
      e.event_code,
      c.id as category_id,
      c.name as category_name,
      c.code as category_code,
      c.price as category_base_price,
      u.name as created_by_name
    FROM passes p
    JOIN billings b ON p.billing_id = b.id
    JOIN events e ON b.event_id = e.id
    JOIN pass_categories c ON b.category_id = c.id
    LEFT JOIN users u ON b.created_by = u.id
    ${whereClause}
    ORDER BY ${safeSortBy} ${safeSortDir}
    LIMIT ? OFFSET ?
  `;

  const rows = await query(dataSql, [...queryParams, pageLimit, offset]);

  return {
    transactions: rows.map(r => ({
      ...r,
      base_price: parseFloat(r.unit_price || r.category_base_price || 0),
      discount: 0.00,
      gst_amount: parseFloat(r.billing_gst || 0),
      final_amount: parseFloat(r.unit_price || r.category_base_price || 0),
      payment_method: 'Direct / Invoice',
      payment_status: r.pass_status === 'void' ? 'VOIDED' : 'COMPLETED',
      sharing_method: r.pass_sharing_method || r.billing_sent_via || 'NONE'
    })),
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
 * Get Category-wise sales performance breakdown
 */
async function getCategorySales(filters) {
  const { whereClause, queryParams } = buildSalesWhere(filters);

  const sql = `
    SELECT
      c.id as category_id,
      c.name as category_name,
      c.code as category_code,
      c.price as category_price,
      e.event_name,
      COUNT(p.id) as total_sold,
      COALESCE(SUM(b.unit_price), 0) as gross_revenue,
      COALESCE(SUM(b.gst_amount / NULLIF(b.quantity, 0)), 0) as total_gst,
      COALESCE(SUM(b.subtotal / NULLIF(b.quantity, 0)), 0) as net_revenue,
      COALESCE(AVG(b.unit_price), c.price) as avg_selling_price
    FROM passes p
    JOIN billings b ON p.billing_id = b.id
    JOIN events e ON b.event_id = e.id
    JOIN pass_categories c ON b.category_id = c.id
    ${whereClause}
    GROUP BY c.id, e.id
    ORDER BY gross_revenue DESC
  `;

  const rows = await query(sql, queryParams);

  // Compute total sales across categories for percentage calculation
  const totalGross = rows.reduce((acc, r) => acc + parseFloat(r.gross_revenue || 0), 0);

  return rows.map(r => {
    const gross = parseFloat(r.gross_revenue || 0);
    const pct = totalGross > 0 ? (gross / totalGross) * 100 : 0;
    return {
      categoryId: r.category_id,
      categoryName: r.category_name,
      categoryCode: r.category_code,
      eventName: r.event_name,
      totalSold: Number(r.total_sold || 0),
      grossRevenue: gross,
      totalGst: parseFloat(r.total_gst || 0),
      discount: 0.00,
      netRevenue: parseFloat(r.net_revenue || gross),
      avgSellingPrice: Math.round(parseFloat(r.avg_selling_price || 0) * 100) / 100,
      percentageOfTotalSales: Math.round(pct * 10) / 10
    };
  });
}

/**
 * Get Event-wise sales performance breakdown (SuperAdmin multi-event drilldown)
 */
async function getEventSales(filters) {
  const { whereClause, queryParams } = buildSalesWhere(filters);

  const sql = `
    SELECT
      e.id as event_id,
      e.event_name,
      e.event_code,
      e.status as event_status,
      COUNT(p.id) as total_passes_sold,
      COUNT(DISTINCT CASE 
        WHEN b.customer_email IS NOT NULL AND b.customer_email != '' THEN b.customer_email 
        WHEN b.customer_phone IS NOT NULL AND b.customer_phone != '' THEN b.customer_phone 
        ELSE b.customer_name 
      END) as total_customers,
      COALESCE(SUM(b.unit_price), 0) as gross_sales,
      COALESCE(SUM(b.gst_amount / NULLIF(b.quantity, 0)), 0) as total_gst,
      COALESCE(SUM(b.subtotal / NULLIF(b.quantity, 0)), 0) as net_revenue,
      SUM(CASE WHEN p.status = 'used' OR p.scan_count > 0 THEN 1 ELSE 0 END) as scanned_passes,
      SUM(CASE WHEN p.status != 'used' AND p.scan_count = 0 AND p.status != 'void' THEN 1 ELSE 0 END) as unused_passes
    FROM passes p
    JOIN billings b ON p.billing_id = b.id
    JOIN events e ON b.event_id = e.id
    LEFT JOIN pass_categories c ON b.category_id = c.id
    ${whereClause}
    GROUP BY e.id
    ORDER BY gross_sales DESC
  `;

  const rows = await query(sql, queryParams);

  return rows.map(r => ({
    eventId: r.event_id,
    eventName: r.event_name,
    eventCode: r.event_code,
    eventStatus: r.event_status,
    totalPassesSold: Number(r.total_passes_sold || 0),
    totalCustomers: Number(r.total_customers || 0),
    grossSales: parseFloat(r.gross_sales || 0),
    totalGst: parseFloat(r.total_gst || 0),
    discount: 0.00,
    netRevenue: parseFloat(r.net_revenue || 0),
    scannedPasses: Number(r.scanned_passes || 0),
    unusedPasses: Number(r.unused_passes || 0)
  }));
}

/**
 * Get Sales Trend over time grouped in IST (Daily / Weekly / Monthly)
 */
async function getSalesTrend(filters, grouping = 'daily') {
  const { whereClause, queryParams } = buildSalesWhere(filters);

  // Group by IST day string (UTC + 5:30)
  // CONVERT_TZ(b.created_at, '+00:00', '+05:30') or DATE_ADD(b.created_at, INTERVAL 330 MINUTE)
  let dateFormatSql;
  if (grouping === 'monthly') {
    dateFormatSql = "DATE_FORMAT(DATE_ADD(b.created_at, INTERVAL 330 MINUTE), '%Y-%m')";
  } else if (grouping === 'weekly') {
    dateFormatSql = "DATE_FORMAT(DATE_ADD(b.created_at, INTERVAL 330 MINUTE), '%x-W%v')";
  } else {
    dateFormatSql = "DATE_FORMAT(DATE_ADD(b.created_at, INTERVAL 330 MINUTE), '%Y-%m-%d')";
  }

  const sql = `
    SELECT
      ${dateFormatSql} as time_bucket,
      COUNT(p.id) as passes_sold,
      COALESCE(SUM(b.unit_price), 0) as revenue
    FROM passes p
    JOIN billings b ON p.billing_id = b.id
    LEFT JOIN pass_categories c ON b.category_id = c.id
    ${whereClause}
    GROUP BY time_bucket
    ORDER BY time_bucket ASC
  `;

  const rows = await query(sql, queryParams);

  return rows.map(r => ({
    timeBucket: r.time_bucket,
    passesSold: Number(r.passes_sold || 0),
    revenue: parseFloat(r.revenue || 0)
  }));
}

/**
 * Get Payment method summary breakdown
 */
async function getPaymentSummary(filters) {
  const { whereClause, queryParams } = buildSalesWhere(filters);

  const sql = `
    SELECT
      'Direct / Invoice' as payment_method,
      COUNT(DISTINCT b.id) as transaction_count,
      COALESCE(SUM(b.total_amount), 0) as total_amount
    FROM billings b
    LEFT JOIN passes p ON p.billing_id = b.id
    LEFT JOIN pass_categories c ON b.category_id = c.id
    ${whereClause}
    GROUP BY payment_method
  `;

  const rows = await query(sql, queryParams);
  const totalGross = rows.reduce((acc, r) => acc + parseFloat(r.total_amount || 0), 0);

  return rows.map(r => {
    const amt = parseFloat(r.total_amount || 0);
    return {
      paymentMethod: r.payment_method,
      transactionCount: Number(r.transaction_count || 0),
      totalAmount: amt,
      percentageOfSales: totalGross > 0 ? Math.round((amt / totalGross) * 1000) / 10 : 100
    };
  });
}

/**
 * Get Customer-level Sales Report summary
 */
async function getCustomerSales(filters) {
  const { page = 1, limit = 20, search = '' } = filters;
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const pageLimit = Math.min(100, Math.max(5, parseInt(limit, 10) || 20));
  const offset = (pageNum - 1) * pageLimit;

  const { whereClause, queryParams } = buildSalesWhere(filters);

  // Group by customer identity
  const countSql = `
    SELECT COUNT(DISTINCT CASE 
      WHEN b.customer_email IS NOT NULL AND b.customer_email != '' THEN b.customer_email 
      WHEN b.customer_phone IS NOT NULL AND b.customer_phone != '' THEN b.customer_phone 
      ELSE b.customer_name 
    END) as total
    FROM billings b
    LEFT JOIN passes p ON p.billing_id = b.id
    LEFT JOIN pass_categories c ON b.category_id = c.id
    ${whereClause}
  `;
  const [countRes] = await query(countSql, queryParams);
  const totalRecords = countRes?.total || 0;
  const totalPages = Math.ceil(totalRecords / pageLimit);

  const dataSql = `
    SELECT
      b.customer_name,
      b.customer_email,
      b.customer_phone,
      COUNT(p.id) as passes_purchased,
      COALESCE(SUM(b.unit_price), 0) as total_spent,
      MIN(b.created_at) as first_purchase,
      MAX(b.created_at) as latest_purchase,
      GROUP_CONCAT(DISTINCT c.name SEPARATOR ', ') as categories_purchased,
      MAX(b.sent_via) as sharing_method,
      SUM(CASE WHEN p.status = 'used' OR p.scan_count > 0 THEN 1 ELSE 0 END) as scanned_count
    FROM passes p
    JOIN billings b ON p.billing_id = b.id
    JOIN pass_categories c ON b.category_id = c.id
    ${whereClause}
    GROUP BY b.customer_name, b.customer_email, b.customer_phone
    ORDER BY total_spent DESC
    LIMIT ? OFFSET ?
  `;

  const rows = await query(dataSql, [...queryParams, pageLimit, offset]);

  return {
    customers: rows.map(r => ({
      customerName: r.customer_name,
      customerEmail: r.customer_email || '—',
      customerPhone: r.customer_phone || '—',
      passesPurchased: Number(r.passes_purchased || 0),
      categoriesPurchased: r.categories_purchased || 'General',
      totalSpent: parseFloat(r.total_spent || 0),
      firstPurchase: formatDateTimeIST(r.first_purchase),
      latestPurchase: formatDateTimeIST(r.latest_purchase),
      sharingMethod: r.sharing_method || 'NONE',
      scanStatus: Number(r.scanned_count || 0) > 0 ? `${r.scanned_count} scanned` : 'Unused'
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
 * Generate formatted Excel (.xlsx) workbook containing filtered Sales Report records
 */
async function exportSalesExcel(filters) {
  // Query matching sales transactions (up to 50,000 records)
  const result = await getSalesTransactions({
    ...filters,
    page: 1,
    limit: 50000
  });

  const summary = await getSalesSummary(filters);
  const transactions = result.transactions || [];

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'EventGen Platform';
  workbook.created = new Date();

  // 1. Transactions Worksheet
  const worksheet = workbook.addWorksheet('Sales Transactions', {
    views: [{ state: 'frozen', ySplit: 1 }]
  });

  worksheet.columns = [
    { header: 'Sale Date (IST)', key: 'sale_date', width: 22 },
    { header: 'Invoice #', key: 'bill_number', width: 18 },
    { header: 'Event Name', key: 'event_name', width: 24 },
    { header: 'Pass Code', key: 'pass_code', width: 14 },
    { header: 'Pass Category', key: 'category_name', width: 18 },
    { header: 'Customer Name', key: 'customer_name', width: 24 },
    { header: 'Email Address', key: 'customer_email', width: 28 },
    { header: 'WhatsApp Number', key: 'customer_phone', width: 18 },
    { header: 'Sponsor', key: 'sponsor_name', width: 18 },
    { header: 'Base Price (₹)', key: 'base_price', width: 14 },
    { header: 'Discount (₹)', key: 'discount', width: 14 },
    { header: 'GST Mode', key: 'gst_mode', width: 12 },
    { header: 'GST Rate (%)', key: 'gst_rate', width: 14 },
    { header: 'GST Amount (₹)', key: 'gst_amount', width: 14 },
    { header: 'Final Amount (₹)', key: 'final_amount', width: 16 },
    { header: 'Payment Method', key: 'payment_method', width: 16 },
    { header: 'Payment Status', key: 'payment_status', width: 16 },
    { header: 'Sharing Method', key: 'sharing_method', width: 16 },
    { header: 'Scan Status', key: 'pass_status', width: 14 },
    { header: 'Scan Count', key: 'scan_count', width: 12 },
    { header: 'First Scan (IST)', key: 'first_scanned_at', width: 22 },
    { header: 'Last Scan (IST)', key: 'last_scanned_at', width: 22 },
    { header: 'Issued By', key: 'created_by_name', width: 18 }
  ];

  // Header Styling
  const headerRow = worksheet.getRow(1);
  headerRow.font = { name: 'Arial', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF0F172A' } // Slate 900
  };
  headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
  headerRow.height = 28;

  // Rows
  for (const t of transactions) {
    const row = worksheet.addRow({
      sale_date: formatDateTimeIST(t.sale_date),
      bill_number: t.bill_number || '—',
      event_name: t.event_name || 'Event 2026',
      pass_code: t.pass_code,
      category_name: t.category_name || t.category_code,
      customer_name: t.customer_name || '—',
      customer_email: t.customer_email || '—',
      customer_phone: t.customer_phone || '—',
      sponsor_name: t.sponsor_name || '—',
      base_price: parseFloat(t.base_price || 0),
      discount: parseFloat(t.discount || 0),
      gst_mode: t.gst_mode || 'INCLUDED',
      gst_rate: parseFloat(t.gst_rate || 18),
      gst_amount: parseFloat(t.gst_amount || 0),
      final_amount: parseFloat(t.final_amount || 0),
      payment_method: t.payment_method || 'Direct',
      payment_status: t.payment_status || 'COMPLETED',
      sharing_method: t.sharing_method || 'NONE',
      pass_status: (t.pass_status || 'active').toUpperCase(),
      scan_count: t.scan_count || 0,
      first_scanned_at: formatDateTimeIST(t.first_scanned_at),
      last_scanned_at: formatDateTimeIST(t.last_scanned_at),
      created_by_name: t.created_by_name || 'Admin'
    });

    row.font = { name: 'Arial', size: 10 };
    row.alignment = { vertical: 'middle' };
  }

  // Zebra striping and borders
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

  // 2. Summary KPI Worksheet
  const summarySheet = workbook.addWorksheet('Sales KPI Summary');
  summarySheet.columns = [
    { header: 'Metric KPI', key: 'metric', width: 30 },
    { header: 'Value', key: 'value', width: 25 }
  ];

  const sumHeader = summarySheet.getRow(1);
  sumHeader.font = { name: 'Arial', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
  sumHeader.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
  sumHeader.height = 26;

  summarySheet.addRows([
    { metric: 'Total Passes Sold', value: summary.totalPassesSold },
    { metric: 'Total Gross Sales (₹)', value: `₹${summary.totalSalesAmount.toFixed(2)}` },
    { metric: 'Total GST Tax (₹)', value: `₹${summary.totalGst.toFixed(2)}` },
    { metric: 'Total Subtotal (₹)', value: `₹${summary.totalSubtotal.toFixed(2)}` },
    { metric: 'Net Revenue (₹)', value: `₹${summary.netRevenue.toFixed(2)}` },
    { metric: 'Average Pass Value (₹)', value: `₹${summary.averagePassValue.toFixed(2)}` },
    { metric: 'Total Distinct Customers', value: summary.totalCustomers },
    { metric: 'Total Invoices Issued', value: summary.totalInvoices },
    { metric: 'Total Voided / Cancelled Passes', value: summary.totalVoidedPasses },
    { metric: 'Report Generated Time (IST)', value: formatDateTimeIST(new Date()) }
  ]);

  summarySheet.eachRow((row, rowNumber) => {
    if (rowNumber > 1) {
      row.font = { name: 'Arial', size: 10, bold: rowNumber === 2 || rowNumber === 6 };
    }
  });

  return workbook.xlsx.writeBuffer();
}

/**
 * Get Cashier-wise Sales & Allocation Performance Breakdown
 */
async function getCashierSalesSummary({ eventId = null, dateFrom = null, dateTo = null }) {
  const whereConditions = [];
  const queryParams = [];

  if (eventId) {
    whereConditions.push('ca.event_id = ?');
    queryParams.push(parseInt(eventId, 10));
  }

  const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

  // 1. Fetch cashier allocation summaries
  const allocationRows = await query(
    `SELECT u.id as cashier_id, u.name as cashier_name, u.email as cashier_email,
            ca.event_id, e.event_name,
            COALESCE(SUM(ca.allocated_quantity), 0) as total_allocated,
            COALESCE(SUM(ca.sold_quantity), 0) as total_sold_via_alloc
     FROM cashier_allocations ca
     JOIN users u ON ca.cashier_id = u.id
     JOIN events e ON ca.event_id = e.id
     ${whereClause}
     GROUP BY u.id, u.name, u.email, ca.event_id, e.event_name
     ORDER BY total_sold_via_alloc DESC, total_allocated DESC`,
    queryParams
  );

  // 2. Fetch actual sales metrics from billings table for each cashier
  const billWhere = [];
  const billParams = [];

  if (eventId) {
    billWhere.push('b.event_id = ?');
    billParams.push(parseInt(eventId, 10));
  }

  if (dateFrom) {
    billWhere.push('b.created_at >= ?');
    billParams.push(`${dateFrom} 00:00:00`);
  }

  if (dateTo) {
    billWhere.push('b.created_at <= ?');
    billParams.push(`${dateTo} 23:59:59`);
  }

  const billWhereClause = billWhere.length > 0 ? `WHERE ${billWhere.join(' AND ')}` : '';

  const salesMetrics = await query(
    `SELECT COALESCE(b.cashier_id, b.created_by) as cashier_id,
            COUNT(b.id) as total_invoices,
            COALESCE(SUM(b.quantity), 0) as total_sold,
            COALESCE(SUM(b.total_amount), 0) as total_revenue,
            COALESCE(AVG(b.unit_price), 0) as avg_price
     FROM billings b
     ${billWhereClause}
     GROUP BY COALESCE(b.cashier_id, b.created_by)`,
    billParams
  );

  const salesMap = {};
  for (const sm of salesMetrics) {
    if (sm.cashier_id) {
      salesMap[sm.cashier_id] = sm;
    }
  }

  const result = allocationRows.map(row => {
    const sm = salesMap[row.cashier_id] || { total_invoices: 0, total_sold: 0, total_revenue: 0, avg_price: 0 };
    const allocated = parseInt(row.total_allocated, 10) || 0;
    const sold = parseInt(sm.total_sold, 10) || parseInt(row.total_sold_via_alloc, 10) || 0;
    const remaining = Math.max(0, allocated - sold);
    const revenue = parseFloat(sm.total_revenue || 0);
    const avgPrice = sold > 0 ? (revenue / sold) : parseFloat(sm.avg_price || 0);

    return {
      cashierId: row.cashier_id,
      cashierName: row.cashier_name,
      cashierEmail: row.cashier_email,
      eventId: row.event_id,
      eventName: row.event_name,
      allocatedQuantity: allocated,
      soldQuantity: sold,
      remainingQuantity: remaining,
      utilizationRate: allocated > 0 ? Math.round((sold / allocated) * 100) : 0,
      totalInvoices: sm.total_invoices || 0,
      totalRevenue: revenue,
      averageSellingPrice: avgPrice
    };
  });

  return result;
}

module.exports = {
  getSalesSummary,
  getSalesTransactions,
  getCategorySales,
  getEventSales,
  getSalesTrend,
  getPaymentSummary,
  getCustomerSales,
  getCashierSalesSummary,
  exportSalesExcel
};
