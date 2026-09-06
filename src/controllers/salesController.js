const salesReportService = require('../services/SalesReportService');

async function getSalesSummary(req, res, next) {
  try {
    const eventId = req.effectiveEventId || req.query.eventId || null;
    const summary = await salesReportService.getSalesSummary({
      ...req.query,
      eventId
    });
    res.json({
      success: true,
      data: summary
    });
  } catch (error) {
    next(error);
  }
}

async function getSalesTransactions(req, res, next) {
  try {
    const eventId = req.effectiveEventId || req.query.eventId || null;
    const result = await salesReportService.getSalesTransactions({
      ...req.query,
      eventId
    });
    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    next(error);
  }
}

async function getCategorySales(req, res, next) {
  try {
    const eventId = req.effectiveEventId || req.query.eventId || null;
    const data = await salesReportService.getCategorySales({
      ...req.query,
      eventId
    });
    res.json({
      success: true,
      data
    });
  } catch (error) {
    next(error);
  }
}

async function getEventSales(req, res, next) {
  try {
    const eventId = req.effectiveEventId || req.query.eventId || null;
    const data = await salesReportService.getEventSales({
      ...req.query,
      eventId
    });
    res.json({
      success: true,
      data
    });
  } catch (error) {
    next(error);
  }
}

async function getSalesTrend(req, res, next) {
  try {
    const eventId = req.effectiveEventId || req.query.eventId || null;
    const grouping = req.query.grouping || 'daily';
    const data = await salesReportService.getSalesTrend({
      ...req.query,
      eventId
    }, grouping);
    res.json({
      success: true,
      data
    });
  } catch (error) {
    next(error);
  }
}

async function getPaymentSummary(req, res, next) {
  try {
    const eventId = req.effectiveEventId || req.query.eventId || null;
    const data = await salesReportService.getPaymentSummary({
      ...req.query,
      eventId
    });
    res.json({
      success: true,
      data
    });
  } catch (error) {
    next(error);
  }
}

async function getCustomerSales(req, res, next) {
  try {
    const eventId = req.effectiveEventId || req.query.eventId || null;
    const result = await salesReportService.getCustomerSales({
      ...req.query,
      eventId
    });
    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    next(error);
  }
}

async function exportSalesExcel(req, res, next) {
  try {
    const eventId = req.effectiveEventId || req.query.eventId || null;
    const buffer = await salesReportService.exportSalesExcel({
      ...req.query,
      eventId
    });

    const filename = `SalesReport_${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getSalesSummary,
  getSalesTransactions,
  getCategorySales,
  getEventSales,
  getSalesTrend,
  getPaymentSummary,
  getCustomerSales,
  exportSalesExcel
};
