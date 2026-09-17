const billingService = require('../services/BillingService');
const { query } = require('../config/db');
const { generatePassPdf, generateMultiPassPdf, generateBillPdf } = require('../services/pdfService');
const eventDeliveryService = require('../services/eventDeliveryService');

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
      includePassCodeOnBill = true,
      isComplementary = false
    } = req.body;

    const isAdmin = req.user?.role === 'SUPERADMIN' || req.user?.role === 'ADMIN' || req.user?.roleId === 1 || req.user?.roleId === 2;
    const effectiveComplementary = isAdmin && Boolean(isComplementary);

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

    const price = effectiveComplementary ? 0 : (unitPrice !== undefined && unitPrice !== null ? parseFloat(unitPrice) : parseFloat(category.price || 0));
    const calc = billingService.calculateGst({
      unitPrice: price,
      quantity,
      gstMode: effectiveComplementary ? 'OFF' : gstMode,
      gstRate: effectiveComplementary ? 0 : gstRate
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
      isComplementary = false,
      sendVia = 'NONE',
      senderName,
      senderEmail,
      emailSubject
    } = req.body;

    const isAdmin = req.user?.role === 'SUPERADMIN' || req.user?.role === 'ADMIN' || req.user?.roleId === 1 || req.user?.roleId === 2;
    const effectiveComplementary = isAdmin && Boolean(isComplementary);

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
      isComplementary: effectiveComplementary,
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

    const passes = await query('SELECT * FROM passes WHERE billing_id = ? ORDER BY id ASC', [id]);
    const events = await query('SELECT * FROM events WHERE id = ?', [billing.event_id]);
    const categories = await query('SELECT * FROM pass_categories WHERE id = ?', [billing.category_id]);
    const styles = billing.style_id ? await query('SELECT * FROM pass_styles WHERE id = ?', [billing.style_id]) : [];

    const event = events[0] || {};
    const category = categories[0] || {};
    let style = styles[0] || null;
    if (!style) {
      const defaultStyles = await query(
        'SELECT * FROM pass_styles WHERE (event_id = ? OR event_id IS NULL) ORDER BY is_default DESC, id ASC LIMIT 1',
        [billing.event_id]
      );
      if (defaultStyles && defaultStyles.length > 0) style = defaultStyles[0];
    }

    const pdfBuffer = await generateMultiPassPdf({
      style,
      passes: passes.length > 0 ? passes : [{ code: 'PASS001' }],
      event,
      category,
      customer: { name: billing.customer_name, email: billing.customer_email, phone: billing.customer_phone },
      sponsor: billing.sponsor_name
    });

    const filename = passes.length > 1 ? `Passes_${billing.bill_number}.pdf` : `Pass_${passes[0]?.code || 'PASS'}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
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

    const passes = await query('SELECT * FROM passes WHERE billing_id = ? ORDER BY id ASC', [id]);
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
    res.setHeader('Content-Disposition', `attachment; filename="Invoice_${billing.bill_number}.pdf"`);
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
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
      'SELECT * FROM billings WHERE download_token = ? OR id = ?',
      [token, /^\d+$/.test(token) ? parseInt(token, 10) : 0]
    );

    if (!billings || billings.length === 0) {
      return res.status(404).json({ success: false, message: 'Download link is invalid or expired' });
    }

    const billing = billings[0];
    const passes = await query('SELECT * FROM passes WHERE billing_id = ? ORDER BY id ASC', [billing.id]);
    const events = await query('SELECT * FROM events WHERE id = ?', [billing.event_id]);
    const categories = await query('SELECT * FROM pass_categories WHERE id = ?', [billing.category_id]);
    const styles = billing.style_id ? await query('SELECT * FROM pass_styles WHERE id = ?', [billing.style_id]) : [];

    const event = events[0] || {};
    const category = categories[0] || {};
    let style = styles[0] || null;
    if (!style) {
      const defaultStyles = await query(
        'SELECT * FROM pass_styles WHERE (event_id = ? OR event_id IS NULL) ORDER BY is_default DESC, id ASC LIMIT 1',
        [billing.event_id]
      );
      if (defaultStyles && defaultStyles.length > 0) style = defaultStyles[0];
    }

    const pdfBuffer = await generateMultiPassPdf({
      style,
      passes: passes.length > 0 ? passes : [{ code: 'PASS2026' }],
      event,
      category,
      customer: { name: billing.customer_name, email: billing.customer_email, phone: billing.customer_phone },
      sponsor: billing.sponsor_name
    });

    const filename = passes.length > 1 ? `Passes_${billing.bill_number}.pdf` : `Pass_${passes[0]?.code || 'PASS'}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
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
      'SELECT * FROM billings WHERE download_token = ? OR id = ?',
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
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.send(pdfBuffer);
  } catch (error) {
    next(error);
  }
}

/**
 * Resend / Retry delivery for an existing billing record without recreating passes
 */
async function resendBillingDelivery(req, res, next) {
  try {
    const { id } = req.params;
    const { sendVia = 'EMAIL', recipientEmail, recipientPhone, emailSubject } = req.body;

    const billings = await query('SELECT * FROM billings WHERE id = ?', [id]);
    if (!billings || billings.length === 0) {
      return res.status(404).json({ success: false, message: 'Billing record not found' });
    }
    const billing = billings[0];

    const passes = await query('SELECT * FROM passes WHERE billing_id = ? ORDER BY id ASC', [id]);
    if (!passes || passes.length === 0) {
      return res.status(404).json({ success: false, message: 'No passes associated with this billing' });
    }

    const events = await query('SELECT * FROM events WHERE id = ?', [billing.event_id]);
    const categories = await query('SELECT * FROM pass_categories WHERE id = ?', [billing.category_id]);
    const styles = billing.style_id ? await query('SELECT * FROM pass_styles WHERE id = ?', [billing.style_id]) : [];

    const event = events[0] || {};
    const category = categories[0] || {};
    let style = styles[0] || null;
    if (!style) {
      const defaultStyles = await query(
        'SELECT * FROM pass_styles WHERE (event_id = ? OR event_id IS NULL) ORDER BY is_default DESC, id ASC LIMIT 1',
        [billing.event_id]
      );
      if (defaultStyles && defaultStyles.length > 0) style = defaultStyles[0];
    }

    const targetEmail = recipientEmail || billing.customer_email;
    const targetPhone = recipientPhone || billing.customer_phone;

    // 1. Generate individual pass PDFs
    const passPdfs = await Promise.all(
      passes.map(async (pass) => {
        const buffer = await generatePassPdf({
          style,
          pass,
          event,
          category,
          customer: { name: billing.customer_name, email: targetEmail, phone: targetPhone },
          sponsor: billing.sponsor_name
        });
        return {
          pass,
          code: pass.code,
          filename: `Pass_${pass.code}.pdf`,
          buffer
        };
      })
    );

    // 2. Multi-Pass merged PDF
    const multiPassPdfBuffer = await generateMultiPassPdf({
      style,
      passes,
      event,
      category,
      customer: { name: billing.customer_name, email: targetEmail, phone: targetPhone },
      sponsor: billing.sponsor_name
    });

    // 3. Bill PDF
    const billPdfBuffer = await generateBillPdf({
      billing,
      event,
      category,
      passes
    });

    let emailDelivery = { success: false, status: 'NOT_REQUESTED' };
    if ((sendVia === 'EMAIL' || sendVia === 'BOTH') && targetEmail) {
      const subject = emailSubject || `${event.event_name} — Pass & Invoice Confirmation (${billing.bill_number})`;
      const emailHtml = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #1E293B; line-height: 1.6;">
          <div style="background-color: #0F172A; padding: 24px; text-align: center; border-radius: 8px 8px 0 0;">
            <h1 style="color: #FFFFFF; margin: 0; font-size: 22px;">${event.event_name}</h1>
            <p style="color: #94A3B8; margin: 6px 0 0 0; font-size: 13px;">Official Pass Delivery & Invoice</p>
          </div>
          <div style="padding: 24px; border: 1px solid #E2E8F0; border-top: none; background-color: #FFFFFF; border-radius: 0 0 8px 8px;">
            <p>Dear <strong>${billing.customer_name}</strong>,</p>
            <p>Here are your official pass(es) and itemized tax invoice for <strong>${event.event_name}</strong>.</p>
            
            <div style="background-color: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 6px; padding: 16px; margin: 20px 0;">
              <table style="width: 100%; font-size: 13.5px;">
                <tr><td style="color: #64748B;">Category:</td><td><strong>${category.name}</strong></td></tr>
                <tr><td style="color: #64748B;">Pass Code(s):</td><td style="font-family: monospace; font-weight: bold; color: #2563EB;">${passes.map(p => p.code).join(', ')}</td></tr>
                <tr><td style="color: #64748B;">Quantity:</td><td><strong>${passes.length} pass(es)</strong></td></tr>
                <tr><td style="color: #64748B;">Total Amount:</td><td><strong style="color: #047857;">₹${parseFloat(billing.total_amount).toFixed(2)}</strong></td></tr>
              </table>
            </div>

            <p style="font-size: 13px; color: #64748B;">
              <strong>Important:</strong> Please download and present the attached Pass PDF(s) with scannable barcodes at the entrance gate.
            </p>
          </div>
        </div>
      `;

      const passAttachments = passPdfs.map(item => ({
        filename: item.filename,
        content: item.buffer,
        contentType: 'application/pdf'
      }));

      emailDelivery = await eventDeliveryService.sendEventEmail({
        eventId: billing.event_id,
        billingId: billing.id,
        to: targetEmail,
        subject,
        html: emailHtml,
        attachments: [
          ...passAttachments,
          {
            filename: `Invoice_${billing.bill_number}.pdf`,
            content: billPdfBuffer,
            contentType: 'application/pdf'
          }
        ]
      });
    }

    let whatsappDelivery = { success: false, status: 'NOT_REQUESTED' };
    if (sendVia === 'WHATSAPP' || sendVia === 'BOTH') {
      whatsappDelivery = await eventDeliveryService.generateEventWhatsappDelivery({
        eventId: billing.event_id,
        customerPhone: targetPhone,
        customerName: billing.customer_name,
        eventName: event.event_name,
        passCodes: passes.map(p => p.code),
        totalAmount: billing.total_amount,
        billingId: billing.id,
        downloadToken: billing.download_token,
        baseUrl: req.protocol + '://' + req.get('host'),
        passPdfBuffer: multiPassPdfBuffer,
        billPdfBuffer
      });
    }

    res.json({
      success: true,
      message: 'Delivery retry processed successfully',
      emailDelivery,
      whatsappDelivery,
      whatsappUrl: whatsappDelivery.whatsappUrl || null
    });
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
  downloadBillPdfByToken,
  resendBillingDelivery
};
