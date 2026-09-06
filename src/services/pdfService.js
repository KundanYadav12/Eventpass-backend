const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const bwipjs = require('bwip-js');
const { formatDateTimeIST, formatDateIST } = require('../utils/timeUtil');

/**
 * Generate a Barcode PNG Buffer using bwip-js (Code 128)
 */
async function generateBarcodeBuffer(text, { width = 200, height = 60 } = {}) {
  return new Promise((resolve, reject) => {
    bwipjs.toBuffer(
      {
        bcid: 'code128',
        text: String(text).toUpperCase(),
        scale: 3,
        height: 12,
        includetext: true,
        textxalign: 'center',
        textsize: 10
      },
      (err, png) => {
        if (err) return reject(err);
        resolve(png);
      }
    );
  });
}

/**
 * Generate a QR Code PNG Buffer
 */
async function generateQrBuffer(text, { width = 150 } = {}) {
  const pixelWidth = Math.max(300, Math.round(width * 3));
  return QRCode.toBuffer(String(text).toUpperCase(), {
    type: 'png',
    width: pixelWidth,
    margin: 1,
    color: {
      dark: '#000000',
      light: '#FFFFFF'
    }
  });
}

/**
 * Normalize barcode format string into 'QR' or 'CODE128'
 */
function normalizeBarcodeFormat(format) {
  if (!format) return null;
  const str = String(format).trim().toUpperCase().replace(/[-_ ]/g, '');
  if (str === 'QR' || str === 'QRCODE' || str === 'QR_CODE') {
    return 'QR';
  }
  if (str === 'CODE128' || str === 'BARCODE' || str === 'C128' || str === '128') {
    return 'CODE128';
  }
  return null;
}

/**
 * Resolves whether an element or style should render as QR Code ('QR') or Code 128 ('CODE128').
 */
function resolveBarcodeFormat(el = {}, style = {}, event = {}) {
  // 1. Explicit element format field
  const elFormat = el.barcodeFormat || el.barcode_format || el.barcodeType || el.barcode_type || el.format;
  if (elFormat) {
    const norm = normalizeBarcodeFormat(elFormat);
    if (norm) return norm;
  }

  // 2. Element type
  if (el.type) {
    const norm = normalizeBarcodeFormat(el.type);
    if (norm) return norm;
  }

  // 3. Element field if explicitly QR
  if (el.field) {
    const norm = normalizeBarcodeFormat(el.field);
    if (norm === 'QR') return 'QR';
  }

  // 4. Style-level configuration
  const styleFormat = style?.barcode_format || style?.barcodeFormat || style?.barcode_type || style?.barcodeType;
  if (styleFormat) {
    const norm = normalizeBarcodeFormat(styleFormat);
    if (norm) return norm;
  }

  // 5. Event-level configuration fallback
  const eventFormat = event?.barcode_type || event?.barcodeType;
  if (eventFormat) {
    const norm = normalizeBarcodeFormat(eventFormat);
    if (norm) return norm;
  }

  // Default fallback: CODE128
  return 'CODE128';
}

/**
 * Render a single pass page onto an existing PDFDocument
 */
async function renderPassOnDocument(doc, {
  style,
  pass,
  event = {},
  category = {},
  customer = {},
  sponsor = '',
  pdfWidth,
  pdfHeight,
  scale,
  canvasWidth,
  canvasHeight,
  isNewPage = false
}) {
  if (isNewPage) {
    doc.addPage({
      size: [pdfWidth, pdfHeight],
      margins: { top: 0, bottom: 0, left: 0, right: 0 }
    });
  }

  // 1. Render Background
  if (style?.background_image_url && style.background_image_url.startsWith('data:image')) {
    try {
      const base64Data = style.background_image_url.split(',')[1];
      const imgBuffer = Buffer.from(base64Data, 'base64');
      doc.image(imgBuffer, 0, 0, { width: pdfWidth, height: pdfHeight });
    } catch (bgErr) {
      console.warn('[PDF] Failed to render base64 background:', bgErr.message);
      drawDefaultBackground(doc, pdfWidth, pdfHeight, category);
    }
  } else {
    drawDefaultBackground(doc, pdfWidth, pdfHeight, category);
  }

  // 2. Elements to render
  let elements = [];
  if (style?.elements_config) {
    elements = typeof style.elements_config === 'string'
      ? JSON.parse(style.elements_config)
      : style.elements_config;
  }

  // If no elements are configured, build a default layout
  if (!Array.isArray(elements) || elements.length === 0) {
    elements = getDefaultElementsConfig(canvasWidth, canvasHeight);
  }

  for (const el of elements) {
    if (el.isVisible === false) continue;

    const x = (el.x || 0) * scale;
    const y = (el.y || 0) * scale;
    const w = (el.width || 200) * scale;
    const h = (el.height || 60) * scale;
    const fontSize = Math.max(8, (el.fontSize || 18) * scale);
    const color = el.fontColor || '#FFFFFF';
    const align = el.textAlign || 'center';

    // Check if barcode or QR code element
    const isBarcodeElement =
      el.type === 'barcode' ||
      el.type === 'qrcode' ||
      el.field === 'barcode' ||
      el.field === 'qrcode' ||
      el.id === 'el_barcode' ||
      el.id === 'el_qrcode';

    if (isBarcodeElement) {
      const format = resolveBarcodeFormat(el, style, event);

      if (format === 'QR') {
        try {
          let qrDim = Math.min(w, h);
          if (h < w * 0.4 && h < 50) {
            qrDim = w;
          }
          const qrX = x + (w > qrDim ? (w - qrDim) / 2 : 0);
          const qrY = y + (h > qrDim ? (h - qrDim) / 2 : 0);
          const qrPng = await generateQrBuffer(pass.code, { width: qrDim });
          doc.image(qrPng, qrX, qrY, { width: qrDim, height: qrDim });
        } catch (qErr) {
          console.warn('[PDF] QR generation error:', qErr.message);
        }
      } else {
        try {
          const barcodePng = await generateBarcodeBuffer(pass.code, { width: w, height: h });
          doc.image(barcodePng, x, y, { width: w, height: h });
        } catch (bErr) {
          console.warn('[PDF] Barcode generation error:', bErr.message);
        }
      }
      continue;
    }

    // Text elements
    let textValue = '';
    switch (el.field) {
      case 'event_name':
        textValue = event.event_name || 'Event 2026';
        break;
      case 'category_name':
        textValue = category.name || pass.code_type || 'VIP Pass';
        break;
      case 'customer_name':
        textValue = customer.name || customer.customer_name || pass.customer_name || 'Pass Holder';
        break;
      case 'pass_code':
        textValue = `CODE: ${pass.code}`;
        break;
      case 'validity':
        textValue = category.valid_from && category.valid_until
          ? `${formatDateIST(category.valid_from)} – ${formatDateIST(category.valid_until)}`
          : 'Valid for Event Entry';
        break;
      case 'sponsor':
        textValue = sponsor || pass.sponsor_name ? `SPONSORED BY ${sponsor || pass.sponsor_name}` : '';
        break;
      case 'price':
        textValue = category.price !== undefined ? `₹${parseFloat(category.price).toFixed(2)}` : '';
        break;
      case 'custom':
      default:
        textValue = el.text || el.label || '';
        break;
    }

    if (textValue) {
      doc
        .fontSize(fontSize)
        .fillColor(color)
        .text(textValue, x, y, {
          width: w,
          align: align,
          lineBreak: true
        });
    }
  }
}

/**
 * Generate Single Pass PDF based on configured Pass Style layout
 */
async function generatePassPdf({ style, pass, event = {}, category = {}, customer = {}, sponsor = '' }) {
  return generateMultiPassPdf({
    style,
    passes: pass ? [pass] : [],
    event,
    category,
    customer,
    sponsor
  });
}

/**
 * Generate Multi-Pass PDF (1 page per pass) based on configured Pass Style layout
 */
async function generateMultiPassPdf({ style, passes = [], event = {}, category = {}, customer = {}, sponsor = '' }) {
  return new Promise(async (resolve, reject) => {
    try {
      const passList = Array.isArray(passes) && passes.length > 0 ? passes : [{ code: 'PASS2026' }];
      const canvasWidth = style?.canvas_width || 800;
      const canvasHeight = style?.canvas_height || 1200;

      // PDF page size in points (e.g. standard vertical pass: 400 x 600 pt)
      const pdfWidth = 400;
      const pdfHeight = (canvasHeight / canvasWidth) * pdfWidth;
      const scale = pdfWidth / canvasWidth;

      const doc = new PDFDocument({
        size: [pdfWidth, pdfHeight],
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
        autoFirstPage: true
      });

      const buffers = [];
      doc.on('data', chunk => buffers.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(buffers)));

      for (let i = 0; i < passList.length; i++) {
        await renderPassOnDocument(doc, {
          style,
          pass: passList[i],
          event,
          category,
          customer,
          sponsor,
          pdfWidth,
          pdfHeight,
          scale,
          canvasWidth,
          canvasHeight,
          isNewPage: i > 0
        });
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Draw a clean, modern aesthetic default background when no image is uploaded
 */
function drawDefaultBackground(doc, width, height, category) {
  // Gradient base
  const grad = doc.linearGradient(0, 0, width, height);
  grad.stop(0, '#0F172A').stop(0.5, '#1E293B').stop(1, '#090D16');
  doc.rect(0, 0, width, height).fill(grad);

  // Decorative border
  doc
    .rect(12, 12, width - 24, height - 24)
    .lineWidth(1.5)
    .stroke('#3B82F6');

  // Decorative header band
  doc
    .rect(14, 14, width - 28, 48)
    .fillOpacity(0.2)
    .fill('#2563EB')
    .fillOpacity(1);
}

/**
 * Default elements layout coordinates
 */
function getDefaultElementsConfig(canvasWidth = 800, canvasHeight = 1200) {
  return [
    { id: 'el_event', type: 'text', field: 'event_name', label: 'Event Name', x: 40, y: 50, width: 720, height: 60, fontSize: 32, fontColor: '#60A5FA', textAlign: 'center' },
    { id: 'el_category', type: 'text', field: 'category_name', label: 'Category', x: 40, y: 130, width: 720, height: 50, fontSize: 26, fontColor: '#F59E0B', textAlign: 'center' },
    { id: 'el_customer', type: 'text', field: 'customer_name', label: 'Customer Name', x: 40, y: 220, width: 720, height: 40, fontSize: 22, fontColor: '#FFFFFF', textAlign: 'center' },
    { id: 'el_validity', type: 'text', field: 'validity', label: 'Validity Window', x: 40, y: 290, width: 720, height: 35, fontSize: 16, fontColor: '#94A3B8', textAlign: 'center' },
    { id: 'el_barcode', type: 'barcode', field: 'barcode', label: 'Barcode', x: 150, y: 400, width: 500, height: 140, isVisible: true },
    { id: 'el_code', type: 'text', field: 'pass_code', label: 'Pass Code', x: 40, y: 560, width: 720, height: 40, fontSize: 24, fontColor: '#38BDF8', textAlign: 'center' },
    { id: 'el_sponsor', type: 'text', field: 'sponsor', label: 'Sponsor Info', x: 40, y: 640, width: 720, height: 35, fontSize: 15, fontColor: '#E2E8F0', textAlign: 'center' }
  ];
}

/**
 * Generate a professional GST Tax Invoice / Bill PDF
 */
async function generateBillPdf({
  billing,
  event = {},
  category = {},
  passes = [],
  platformName = 'EventGen'
}) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 40 });
      const buffers = [];

      doc.on('data', chunk => buffers.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(buffers)));

      const billNo = billing.bill_number || `BILL-${Date.now()}`;
      const issueDate = formatDateTimeIST(billing.created_at || new Date());
      const custName = billing.customer_name || 'Valued Customer';
      const custEmail = billing.customer_email || '—';
      const custPhone = billing.customer_phone || '—';
      const eventName = event.event_name || 'Event 2026';
      const venue = event.venue || 'Event Venue';
      const catName = category.name || 'Standard Pass';
      const qty = parseInt(billing.quantity || 1, 10);
      const unitPrice = parseFloat(billing.unit_price || 0);
      const subtotal = parseFloat(billing.subtotal || unitPrice * qty);
      const gstMode = billing.gst_mode || 'INCLUDED';
      const gstRate = parseFloat(billing.gst_rate || 18);
      const gstAmount = parseFloat(billing.gst_amount || 0);
      const totalAmount = parseFloat(billing.total_amount || subtotal);
      const sponsor = billing.sponsor_name;
      const includeCodes = Boolean(billing.include_pass_code_on_bill);

      // 1. Header Banner
      doc
        .rect(40, 40, 515, 65)
        .fill('#0F172A');

      doc
        .fontSize(22)
        .fillColor('#FFFFFF')
        .text(platformName, 55, 52, { continued: true })
        .fontSize(12)
        .fillColor('#94A3B8')
        .text('  •  TAX INVOICE & RECEIPT', { align: 'left' });

      doc
        .fontSize(10)
        .fillColor('#38BDF8')
        .text(`Invoice #: ${billNo}`, 55, 82, { continued: true })
        .fillColor('#94A3B8')
        .text(`    Date: ${issueDate}`, { align: 'left' });

      // 2. Customer & Event Context Box
      const boxY = 120;
      doc
        .rect(40, boxY, 250, 100)
        .fillAndStroke('#F8FAFC', '#E2E8F0');

      doc
        .fontSize(11)
        .fillColor('#1E293B')
        .text('BILLED TO:', 52, boxY + 12)
        .fontSize(12)
        .font('Helvetica-Bold')
        .text(custName, 52, boxY + 28)
        .font('Helvetica')
        .fontSize(10)
        .fillColor('#475569')
        .text(`Email: ${custEmail}`, 52, boxY + 46)
        .text(`Phone: ${custPhone}`, 52, boxY + 62);

      // Event Context Box
      doc
        .rect(305, boxY, 250, 100)
        .fillAndStroke('#F8FAFC', '#E2E8F0');

      doc
        .fontSize(11)
        .fillColor('#1E293B')
        .text('EVENT DETAILS:', 317, boxY + 12)
        .fontSize(12)
        .font('Helvetica-Bold')
        .text(eventName, 317, boxY + 28)
        .font('Helvetica')
        .fontSize(10)
        .fillColor('#475569')
        .text(`Venue: ${venue}`, 317, boxY + 46)
        .text(`Category: ${catName}`, 317, boxY + 62);

      if (sponsor) {
        doc
          .fontSize(9.5)
          .fillColor('#D97706')
          .text(`★ Sponsored by: ${sponsor}`, 317, boxY + 78);
      }

      // 3. Itemized Pricing Table
      const tableY = 240;
      doc
        .rect(40, tableY, 515, 26)
        .fill('#1E293B');

      doc
        .fontSize(10)
        .font('Helvetica-Bold')
        .fillColor('#FFFFFF')
        .text('ITEM DESCRIPTION', 52, tableY + 8)
        .text('QTY', 280, tableY + 8, { width: 40, align: 'center' })
        .text('UNIT PRICE', 330, tableY + 8, { width: 70, align: 'right' })
        .text('GST STATUS', 410, tableY + 8, { width: 65, align: 'center' })
        .text('TOTAL', 485, tableY + 8, { width: 60, align: 'right' });

      // Table Row
      const rowY = tableY + 26;
      doc
        .rect(40, rowY, 515, 34)
        .fillAndStroke('#FFFFFF', '#E2E8F0');

      const gstLabel = gstMode === 'INCLUDED' ? `Incl. (${gstRate}%)` : (gstMode === 'EXCLUDED' ? `+${gstRate}% GST` : 'GST OFF (0%)');

      doc
        .font('Helvetica')
        .fontSize(10)
        .fillColor('#0F172A')
        .text(`${eventName} — ${catName}`, 52, rowY + 11)
        .text(String(qty), 280, rowY + 11, { width: 40, align: 'center' })
        .text(`₹${unitPrice.toFixed(2)}`, 330, rowY + 11, { width: 70, align: 'right' })
        .fontSize(9)
        .fillColor('#64748B')
        .text(gstLabel, 410, rowY + 12, { width: 65, align: 'center' })
        .fontSize(10)
        .fillColor('#0F172A')
        .text(`₹${totalAmount.toFixed(2)}`, 485, rowY + 11, { width: 60, align: 'right' });

      // 4. Totals Breakdown Card
      const totalCardY = rowY + 45;
      doc
        .rect(305, totalCardY, 250, 95)
        .fillAndStroke('#F1F5F9', '#CBD5E1');

      doc
        .fontSize(10)
        .fillColor('#334155')
        .text('Subtotal (Base):', 317, totalCardY + 10)
        .text(`₹${subtotal.toFixed(2)}`, 450, totalCardY + 10, { align: 'right', width: 95 });

      if (gstMode !== 'OFF') {
        const gstTitle = gstMode === 'INCLUDED' ? `GST (${gstRate}% Included):` : `GST (${gstRate}% Excluded):`;
        doc
          .text(gstTitle, 317, totalCardY + 28)
          .text(`₹${gstAmount.toFixed(2)}`, 450, totalCardY + 28, { align: 'right', width: 95 });
      } else {
        doc
          .text('GST (Exempt/OFF):', 317, totalCardY + 28)
          .text('₹0.00', 450, totalCardY + 28, { align: 'right', width: 95 });
      }

      doc
        .moveTo(317, totalCardY + 48)
        .lineTo(545, totalCardY + 48)
        .stroke('#94A3B8');

      doc
        .font('Helvetica-Bold')
        .fontSize(12)
        .fillColor('#0F172A')
        .text('Grand Total Paid:', 317, totalCardY + 58)
        .fillColor('#047857')
        .text(`₹${totalAmount.toFixed(2)}`, 430, totalCardY + 58, { align: 'right', width: 115 });

      // 5. Optional Pass Codes Table
      let currentY = totalCardY + 110;
      if (includeCodes && Array.isArray(passes) && passes.length > 0) {
        doc
          .font('Helvetica-Bold')
          .fontSize(11)
          .fillColor('#1E293B')
          .text('ISSUED PASS CODES FOR ENTRY:', 40, currentY);

        currentY += 18;

        doc
          .rect(40, currentY, 515, 20)
          .fill('#334155');

        doc
          .fontSize(9)
          .fillColor('#FFFFFF')
          .text('#', 50, currentY + 5)
          .text('PASS CODE', 80, currentY + 5)
          .text('TIER / CATEGORY', 200, currentY + 5)
          .text('STATUS', 380, currentY + 5)
          .text('SECURITY SIGNATURE', 450, currentY + 5);

        currentY += 20;

        passes.forEach((p, idx) => {
          doc
            .rect(40, currentY, 515, 18)
            .fillAndStroke(idx % 2 === 0 ? '#FFFFFF' : '#F8FAFC', '#E2E8F0');

          doc
            .font('Helvetica')
            .fontSize(9)
            .fillColor('#0F172A')
            .text(String(idx + 1), 50, currentY + 4)
            .font('Helvetica-Bold')
            .text(p.code, 80, currentY + 4)
            .font('Helvetica')
            .text(catName, 200, currentY + 4)
            .fillColor('#047857')
            .text('ACTIVE', 380, currentY + 4)
            .fillColor('#64748B')
            .text(p.hmac_sig ? p.hmac_sig.substring(0, 12) + '...' : 'VERIFIED', 450, currentY + 4);

          currentY += 18;
        });
      }

      // 6. Footer Notice
      const footerY = Math.max(currentY + 20, 740);
      doc
        .fontSize(9)
        .fillColor('#94A3B8')
        .text('Please present the attached official Pass PDF with Barcode at the entry gate.', 40, footerY, { align: 'center', width: 515 })
        .text('This is a computer-generated invoice and pass confirmation. No physical signature required.', 40, footerY + 14, { align: 'center', width: 515 });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = {
  generateBarcodeBuffer,
  generateQrBuffer,
  generatePassPdf,
  generateMultiPassPdf,
  generateBillPdf,
  normalizeBarcodeFormat,
  resolveBarcodeFormat
};
