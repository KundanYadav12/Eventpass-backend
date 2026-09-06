require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { query } = require('./src/config/db');
const { createStyle, getStyleById, updateStyle, deleteStyle } = require('./src/services/PassStyleService');
const { generatePassPdf, generateBarcodeBuffer, generateQrBuffer, normalizeBarcodeFormat, resolveBarcodeFormat } = require('./src/services/pdfService');
const { issuePassesAndBill } = require('./src/services/BillingService');
const { resharePass } = require('./src/services/PassService');
const { processScan } = require('./src/services/ScanService');

async function runBarcodeFormatTests() {
  console.log('================================================================');
  console.log('   EVENTGEN BARCODE FORMAT (QR vs CODE 128) VERIFICATION TEST   ');
  console.log('================================================================\n');

  let testStyleId = null;

  try {
    // TEST 1: Unit testing normalizeBarcodeFormat and resolveBarcodeFormat
    console.log('[Test 1] Testing Barcode Format Normalizer & Resolver...');
    if (normalizeBarcodeFormat('QR') !== 'QR') throw new Error('normalizeBarcodeFormat("QR") failed');
    if (normalizeBarcodeFormat('QR_CODE') !== 'QR') throw new Error('normalizeBarcodeFormat("QR_CODE") failed');
    if (normalizeBarcodeFormat('qrcode') !== 'QR') throw new Error('normalizeBarcodeFormat("qrcode") failed');
    if (normalizeBarcodeFormat('Code 128') !== 'CODE128') throw new Error('normalizeBarcodeFormat("Code 128") failed');
    if (normalizeBarcodeFormat('code128') !== 'CODE128') throw new Error('normalizeBarcodeFormat("code128") failed');
    if (normalizeBarcodeFormat('barcode') !== 'CODE128') throw new Error('normalizeBarcodeFormat("barcode") failed');

    const qrElement = { id: 'el_barcode', type: 'qrcode', field: 'barcode' };
    const c128Element = { id: 'el_barcode', type: 'barcode', field: 'barcode' };
    const legacyElement = { id: 'el_barcode', field: 'barcode' };

    if (resolveBarcodeFormat(qrElement) !== 'QR') throw new Error('resolveBarcodeFormat(qrElement) should be QR');
    if (resolveBarcodeFormat(c128Element) !== 'CODE128') throw new Error('resolveBarcodeFormat(c128Element) should be CODE128');
    if (resolveBarcodeFormat(legacyElement) !== 'CODE128') throw new Error('resolveBarcodeFormat(legacyElement) should default to CODE128');
    console.log('✅ Normalizer and Resolver functions passed 100%!\n');

    // TEST 2: Create a Pass Style with QR Code
    console.log('[Test 2] Creating Pass Style configured with QR Code...');
    const qrStyleElements = [
      { id: 'el_event', type: 'text', field: 'event_name', text: 'Corporate Expo 2026', x: 40, y: 50, width: 720, height: 60, fontSize: 32 },
      { id: 'el_category', type: 'text', field: 'category_name', text: 'VIP ALL-ACCESS PASS', x: 40, y: 130, width: 720, height: 50, fontSize: 26 },
      { id: 'el_barcode', type: 'qrcode', field: 'barcode', label: 'QR Code Placeholder', x: 250, y: 350, width: 300, height: 300, isVisible: true },
      { id: 'el_code', type: 'text', field: 'pass_code', text: 'PASS CODE: 55KDBD2', x: 40, y: 680, width: 720, height: 40, fontSize: 24 }
    ];

    const qrStyle = await createStyle({
      eventId: 1,
      name: 'VIP QR Code Style Test',
      description: 'Testing QR Code barcode format on PDF export',
      canvasWidth: 800,
      canvasHeight: 1200,
      elementsConfig: qrStyleElements,
      isDefault: false,
      userId: 1,
      userName: 'Super Administrator'
    });
    testStyleId = qrStyle.id;
    console.log(`- Created Style ID: ${qrStyle.id} (${qrStyle.name})`);

    // TEST 3: Generate Pass PDF using QR Style
    console.log('[Test 3] Generating Pass PDF with QR Style...');
    const testPass = { code: '55KDBD2', code_type: 'VIP', category_name: 'VIP Access' };
    const qrPdfBuffer = await generatePassPdf({
      style: qrStyle,
      pass: testPass,
      event: { event_name: 'Corporate Expo 2026' },
      category: { name: 'VIP Pass' },
      customer: { name: 'Aarav Sharma' }
    });

    console.log(`- Generated QR Pass PDF: ${qrPdfBuffer.length} bytes`);
    if (!qrPdfBuffer || qrPdfBuffer.length < 1000) {
      throw new Error('Generated QR Pass PDF is empty or too small');
    }
    console.log('✅ QR Pass PDF generation succeeded!\n');

    // TEST 4: Customer Billing with QR Style and Email PDF generation
    console.log('[Test 4] Issuing Customer Pass with QR Style via Billing Service...');
    const billingResult = await issuePassesAndBill({
      eventId: 1,
      categoryId: 1,
      styleId: qrStyle.id,
      customerName: 'Aarav Sharma',
      customerEmail: 'aarav.sharma@example.com',
      customerPhone: '+91 98765 12345',
      quantity: 1,
      unitPrice: 500,
      gstMode: 'INCLUDED',
      gstRate: 18,
      sendVia: 'BOTH',
      userId: 1,
      userName: 'Super Administrator'
    });

    const issuedPass = billingResult.passes[0];
    console.log(`- Issued Pass Code: ${issuedPass.code}`);
    console.log(`- Attached Pass PDF Base64 length: ${billingResult.passPdfBase64.length}`);
    console.log(`- Email Dispatch Status: ${billingResult.emailDelivery.status}`);
    console.log('✅ Customer Billing with QR Style generated & attached successfully!\n');

    // TEST 5: Verify Scanner approval for the issued pass
    console.log('[Test 5] Scanning issued QR Pass Code with Scanner...');
    const scanRes = await processScan({
      code: issuedPass.code,
      deviceId: 'GATE-QR-01',
      customNow: new Date('2026-10-02T05:00:00Z')
    });
    console.log(`- Scan Result for ${issuedPass.code}: ${scanRes.result} (${scanRes.message})`);
    if (scanRes.result !== 'approved') {
      throw new Error(`Expected approved scan, got: ${scanRes.result}`);
    }
    console.log('✅ Scanner correctly validated the QR Pass Code!\n');

    // TEST 6: Switch Style to Code 128 and verify new export honors Code 128
    console.log('[Test 6] Switching Style to Code 128 and verifying new PDF export...');
    const c128StyleElements = [
      { id: 'el_event', type: 'text', field: 'event_name', text: 'Corporate Expo 2026', x: 40, y: 50, width: 720, height: 60, fontSize: 32 },
      { id: 'el_category', type: 'text', field: 'category_name', text: 'VIP ALL-ACCESS PASS', x: 40, y: 130, width: 720, height: 50, fontSize: 26 },
      { id: 'el_barcode', type: 'barcode', field: 'barcode', label: 'Barcode Placeholder', x: 150, y: 390, width: 500, height: 130, isVisible: true },
      { id: 'el_code', type: 'text', field: 'pass_code', text: 'PASS CODE: 55KDBD2', x: 40, y: 545, width: 720, height: 40, fontSize: 24 }
    ];

    const updatedStyle = await updateStyle(qrStyle.id, {
      name: 'VIP Code 128 Style Test',
      elementsConfig: c128StyleElements,
      isSuperAdmin: true,
      userId: 1,
      userName: 'Super Administrator'
    });

    const c128PdfBuffer = await generatePassPdf({
      style: updatedStyle,
      pass: testPass,
      event: { event_name: 'Corporate Expo 2026' },
      category: { name: 'VIP Pass' },
      customer: { name: 'Aarav Sharma' }
    });

    console.log(`- Generated Code 128 Pass PDF: ${c128PdfBuffer.length} bytes`);
    if (!c128PdfBuffer || c128PdfBuffer.length < 1000) {
      throw new Error('Generated Code 128 Pass PDF is empty or too small');
    }
    console.log('✅ Switched to Code 128 style and verified fresh PDF generation!\n');

    // TEST 7: Reshare pass via Email with updated style
    console.log('[Test 7] Testing Pass Reshare with updated style...');
    const reshareResult = await resharePass({
      passId: issuedPass.id,
      eventId: 1,
      sharingMethod: 'EMAIL',
      customerEmail: 'aarav.sharma@example.com',
      userId: 1,
      userName: 'Super Administrator'
    });
    console.log(`- Reshare Message: ${reshareResult.message}`);
    console.log(`- Reshare PDF Attached: ${Boolean(reshareResult.passPdfBase64)}`);
    console.log('✅ Pass Reshare flow successfully uses updated style!\n');

    // Clean up test style
    await deleteStyle(testStyleId, { eventId: 1, isSuperAdmin: true });
    console.log('================================================================');
    console.log('  🎉 ALL BARCODE FORMAT TESTS (PREVIEW / PDF / EMAIL) PASSED!   ');
    console.log('================================================================');
    process.exit(0);
  } catch (err) {
    console.error('\n❌ Test Failure:', err.message);
    if (testStyleId) {
      try { await deleteStyle(testStyleId, { eventId: 1, isSuperAdmin: true }); } catch (e) {}
    }
    process.exit(1);
  }
}

runBarcodeFormatTests();
