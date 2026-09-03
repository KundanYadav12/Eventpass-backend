const billingService = require('../services/BillingService');
const { query } = require('../config/db');
const { generatePassPdf, generateBillPdf } = require('../services/pdfService');

async function previewBilling(req, res, next) {
  try {
    const {
      eventId,
      categoryId,
      styleId,
      customerName = 'Sample Customer',
      customerEmail,
      customerPhone,
      sponsorName,
      quantity = 1,
      unitPrice,
      gstMode = 'INCLUDED',
      gstRate = 18,
      includePassCodeOnBill = true
    } = req.body;

    const targetEventId = req.effectiveEventId || eventId;
    if (!targetEventId || !categoryId) {
      return res.status(400).json({ success: false, message: 'Event and Category are required for preview' });
    }

    const eventRows = await query('SELECT * FROM events WHERE id = ?', [targetEventId]);
    const catRows = await query('SELECT * FROM pass_categories WHERE id = ?', [categoryId]);
    if (!eventRows || eventRows.length === 0 || !catRows || catRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Event or Category not found' });
    }

    const event = eventRows[0];
    const category = catRows[0];

    let style = null;
    if (styleId) {
      const styleRows = await query('SELECT * FROM pass_styles WHERE id = ?', [styleId]);
      if (styleRows && styleRows.length > 0) style = styleRows[0];
    }
    if (!style) {
      const defaultStyles = await query(
        'SELECT * FROM pass_styles WHERE (event_id = ? OR event_id IS NULL) ORDER BY is_default DESC, id ASC LIMIT 1',
        [targetEventId]
      );
      if (defaultStyles && defaultStyles.length > 0) style = defaultStyles[0];
    }

    const price = unitPrice !== undefined && unitPrice !== null ? parseFloat(unitPrice) : parseFloat(category.price || 0);
    const calc = billingService.calculateGst({
      unitPrice: price,
      quantity,
      gstMode,
      gstRate
    });

    // Sample pass for preview
    const samplePass = {
      code: 'PREVIEW7',
      code_type: category.code,
      customer_name: customerName,
      sponsor_name: sponsorName
    };

    const mockBilling = {
      bill_number: 'INV-PREVIEW-001',
      customer_name: customerName,
      customer_email: customerEmail || 'customer@example.com',
      customer_phone: customerPhone || '+91 98765 43210',
      sponsor_name: sponsorName,
      quantity: calc.quantity,
      unit_price: calc.unitPrice,
      subtotal: calc.subtotal,
      gst_mode: calc.gstMode,
      gst_rate: calc.gstRate,
      gst_amount: calc.gstAmount,
      total_amount: calc.totalAmount,
      include_pass_code_on_bill: includePassCodeOnBill,
      created_at: new Date()
    };

    // Generate preview buffers
    const passPdfBuffer = await generatePassPdf({
      style,
      pass: samplePass,
      event,
      category,
      customer: { name: customerName },
      sponsor: sponsorName
    });

    const billPdfBuffer = await generateBillPdf({
      billing: mockBilling,
      event,
      category,
      passes: [samplePass]
    });

    res.json({
      success: true,
      calculation: calc,
      event: { id: event.id, name: event.event_name },
      category: { id: category.id, name: category.name, price: category.price },
      style: style ? { id: style.id, name: style.name } : null,
      passPdfBase64: passPdfBuffer.toString('base64'),
      billPdfBase64: billPdfBuffer.toString('base64')
    });
  } catch (error) {
    next(error);
  }
}

async function issuePassesAndBill(req, res, next) {
  try {
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
      includePassCodeOnBill = true,
      sendVia = 'NONE',
      senderName,
      senderEmail,
      emailSubject
    } = req.body;

    const targetEventId = req.effectiveEventId || eventId;

    // Calculate dynamic base URL from incoming request
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.headers['x-forwarded-host'] || req.get('host') || 'localhost:5006';
    const reqBaseUrl = process.env.PUBLIC_URL || process.env.APP_BASE_URL || `${proto}://${host}`;

    const result = await billingService.issuePassesAndBill({
      eventId: targetEventId,
      categoryId: parseInt(categoryId, 10),
      styleId: styleId ? parseInt(styleId, 10) : null,
      customerName,
      customerEmail,
      customerPhone,
      sponsorName,
      quantity: parseInt(quantity, 10) || 1,
      unitPrice,
      gstMode,
      gstRate,
      includePassCodeOnBill: Boolean(includePassCodeOnBill),
      sendVia,
      senderName,
      senderEmail,
      emailSubject,
      userId: req.user?.id,
      userName: req.user?.name,
      ipAddress: req.ip || req.connection.remoteAddress,
      userAgent: req.headers['user-agent'],
      baseUrl: reqBaseUrl
    });

    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
}

async function getBillingHistory(req, res, next) {
  try {
    const eventId = req.effectiveEventId || req.query.eventId || null;
    const { page = 1, limit = 20, search = '' } = req.query;

    const result = await billingService.getBillingHistory({
      eventId,
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

async function downloadPassPdf(req, res, next) {
  try {
    const { id } = req.params;
    const billings = await query('SELECT * FROM billings WHERE id = ?', [id]);
    if (!billings || billings.length === 0) return res.status(404).json({ success: false, message: 'Billing not found' });
    const billing = billings[0];

    const passes = await query('SELECT * FROM passes WHERE billing_id = ? LIMIT 1', [id]);
    const events = await query('SELECT * FROM events WHERE id = ?', [billing.event_id]);
    const categories = await query('SELECT * FROM pass_categories WHERE id = ?', [billing.category_id]);
    const styles = billing.style_id ? await query('SELECT * FROM pass_styles WHERE id = ?', [billing.style_id]) : [];

    const pass = passes[0] || { code: 'PASS001' };
    const event = events[0] || {};
    const category = categories[0] || {};
    const style = styles[0] || null;

    const pdfBuffer = await generatePassPdf({
      style,
      pass,
      event,
      category,
      customer: { name: billing.customer_name },
      sponsor: billing.sponsor_name
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=Pass_${pass.code}.pdf`);
    res.send(pdfBuffer);
  } catch (error) {
    next(error);
  }
}

async function downloadBillPdf(req, res, next) {
  try {
    const { id } = req.params;
    const billings = await query('SELECT * FROM billings WHERE id = ?', [id]);
    if (!billings || billings.length === 0) return res.status(404).json({ success: false, message: 'Billing not found' });
    const billing = billings[0];

    const passes = await query('SELECT * FROM passes WHERE billing_id = ?', [id]);
    const events = await query('SELECT * FROM events WHERE id = ?', [billing.event_id]);
    const categories = await query('SELECT * FROM pass_categories WHERE id = ?', [billing.category_id]);

    const event = events[0] || {};
    const category = categories[0] || {};

    const pdfBuffer = await generateBillPdf({
      billing,
      event,
      category,
      passes
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=Invoice_${billing.bill_number}.pdf`);
    res.send(pdfBuffer);
  } catch (error) {
    next(error);
  }
}

/**
 * Public & Secure Pass PDF Streamer by non-sequential token or ID
 */
async function downloadPassPdfByToken(req, res, next) {
  try {
    const token = req.params.token || req.params.id;
    if (!token) {
      return res.status(400).json({ success: false, message: 'Download token is required' });
    }

    const billings = await query(
      'SELECT * FROM billings WHERE download_token = ? OR (id = ? AND download_token IS NULL)',
      [token, /^\d+$/.test(token) ? parseInt(token, 10) : 0]
    );

    if (!billings || billings.length === 0) {
      return res.status(404).json({ success: false, message: 'Download link is invalid or expired' });
    }

    const billing = billings[0];
    const passes = await query('SELECT * FROM passes WHERE billing_id = ? ORDER BY id ASC LIMIT 1', [billing.id]);
    const events = await query('SELECT * FROM events WHERE id = ?', [billing.event_id]);
    const categories = await query('SELECT * FROM pass_categories WHERE id = ?', [billing.category_id]);
    const styles = billing.style_id ? await query('SELECT * FROM pass_styles WHERE id = ?', [billing.style_id]) : [];

    const pass = passes[0] || { code: 'PASS2026' };
    const event = events[0] || {};
    const category = categories[0] || {};
    const style = styles[0] || null;

    const pdfBuffer = await generatePassPdf({
      style,
      pass,
      event,
      category,
      customer: { name: billing.customer_name, email: billing.customer_email, phone: billing.customer_phone },
      sponsor: billing.sponsor_name
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="Pass_${pass.code}.pdf"`);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(pdfBuffer);
  } catch (error) {
    next(error);
  }
}

/**
 * Public & Secure Bill Invoice PDF Streamer by non-sequential token or ID
 */
async function downloadBillPdfByToken(req, res, next) {
  try {
    const token = req.params.token || req.params.id;
    if (!token) {
      return res.status(400).json({ success: false, message: 'Download token is required' });
    }

    const billings = await query(
      'SELECT * FROM billings WHERE download_token = ? OR (id = ? AND download_token IS NULL)',
      [token, /^\d+$/.test(token) ? parseInt(token, 10) : 0]
    );

    if (!billings || billings.length === 0) {
      return res.status(404).json({ success: false, message: 'Download link is invalid or expired' });
    }

    const billing = billings[0];
    const passes = await query('SELECT * FROM passes WHERE billing_id = ? ORDER BY id ASC', [billing.id]);
    const events = await query('SELECT * FROM events WHERE id = ?', [billing.event_id]);
    const categories = await query('SELECT * FROM pass_categories WHERE id = ?', [billing.category_id]);

    const event = events[0] || {};
    const category = categories[0] || {};

    const pdfBuffer = await generateBillPdf({
      billing,
      event,
      category,
      passes
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="Invoice_${billing.bill_number}.pdf"`);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(pdfBuffer);
  } catch (error) {
    next(error);
  }
}

module.exports = {
  previewBilling,
  issuePassesAndBill,
  getBillingHistory,
  downloadPassPdf: downloadPassPdfByToken,
  downloadBillPdf: downloadBillPdfByToken,
  downloadPassPdfByToken,
  downloadBillPdfByToken
};
