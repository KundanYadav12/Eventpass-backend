const cashierSalesService = require('../services/CashierSalesService');

async function sellPass(req, res, next) {
  try {
    const cashierId = req.user?.id;
    const {
      eventId,
      categoryId,
      styleId,
      customerName,
      customerEmail,
      customerPhone,
      sponsorName,
      quantity = 1,
      unitPrice,
      gstMode = 'INCLUDED',
      gstRate = 18,
      sendVia = 'NONE',
      senderName,
      senderEmail,
      emailSubject
    } = req.body;

    const targetEventId = req.effectiveEventId || eventId || req.user?.eventId;
    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'];

    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.headers['x-forwarded-host'] || req.get('host') || 'localhost:5006';
    const baseUrl = process.env.PUBLIC_URL || `${proto}://${host}`;

    const result = await cashierSalesService.sellPasses({
      cashierId,
      eventId: parseInt(targetEventId, 10),
      categoryId: parseInt(categoryId, 10),
      styleId: styleId ? parseInt(styleId, 10) : null,
      customerName,
      customerEmail,
      customerPhone,
      sponsorName,
      quantity: parseInt(quantity, 10) || 1,
      unitPrice: unitPrice !== undefined && unitPrice !== null ? parseFloat(unitPrice) : null,
      gstMode,
      gstRate: parseFloat(gstRate) || 18,
      sendVia,
      senderName,
      senderEmail,
      emailSubject,
      ipAddress,
      userAgent,
      baseUrl
    });

    res.status(201).json({
      success: true,
      message: `Sale successful (${result.quantity} pass${result.quantity > 1 ? 'es' : ''} sold)`,
      sale: result,
      data: result
    });
  } catch (error) {
    if (
      error.message.includes('minimum selling price') ||
      error.message.includes('Minimum allowed') ||
      error.message.includes('Selling price') ||
      error.message.includes('Insufficient') ||
      error.message.includes('allocation') ||
      error.message.includes('required') ||
      error.message.includes('valid') ||
      error.message.includes('Invalid')
    ) {
      return res.status(400).json({
        success: false,
        message: error.message
      });
    }
    next(error);
  }
}

async function getMySales(req, res, next) {
  try {
    const cashierId = req.user?.id;
    const eventId = req.effectiveEventId || req.query.eventId || req.user?.eventId || null;
    const { search, categoryId, dateFrom, dateTo, page = 1, limit = 20 } = req.query;

    const result = await cashierSalesService.getMySales({
      cashierId,
      eventId,
      search,
      categoryId,
      dateFrom,
      dateTo,
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

async function exportMySalesExcel(req, res, next) {
  try {
    const cashierId = req.user?.id;
    const eventId = req.effectiveEventId || req.query.eventId || req.user?.eventId || null;
    const { search, dateFrom, dateTo } = req.query;

    const buffer = await cashierSalesService.exportMySalesExcel({
      cashierId,
      eventId,
      search,
      dateFrom,
      dateTo
    });

    const filename = `MySales_${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (error) {
    next(error);
  }
}

module.exports = {
  sellPass,
  getMySales,
  exportMySalesExcel
};
