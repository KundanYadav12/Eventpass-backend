require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { query } = require('./src/config/db');
const { calculateGst, issuePassesAndBill } = require('./src/services/BillingService');
const { createStyle, getStyleById, deleteStyle } = require('./src/services/PassStyleService');
const { generatePassPdf, generateBillPdf } = require('./src/services/pdfService');
const { processScan } = require('./src/services/ScanService');

async function runTests() {
  console.log('================================================================');
  console.log('   PASS DESIGNER, BILLING, GST & PDF GENERATION TESTS          ');
  console.log('================================================================\n');

  try {
    // 1. Test GST Calculation Engine
    console.log('[Test 1] Validating GST Calculation Modes...');
    
    // Case A: GST INCLUDED (₹118 Total @ 18% GST -> Base ₹100, GST ₹18)
    const gstInc = calculateGst({ unitPrice: 118, quantity: 1, gstMode: 'INCLUDED', gstRate: 18 });
    console.log('  Case A (GST Included @ 18% on ₹118): Subtotal = ₹' + gstInc.subtotal + ', GST = ₹' + gstInc.gstAmount + ', Total = ₹' + gstInc.totalAmount);
    if (gstInc.subtotal !== 100 || gstInc.gstAmount !== 18 || gstInc.totalAmount !== 118) {
      throw new Error(`GST Included calculation mismatch: ${JSON.stringify(gstInc)}`);
    }

    // Case B: GST EXCLUDED (Base ₹100 @ 18% GST -> GST ₹18, Total ₹118)
    const gstExc = calculateGst({ unitPrice: 100, quantity: 2, gstMode: 'EXCLUDED', gstRate: 18 });
    console.log('  Case B (GST Excluded @ 18% on 2 x ₹100): Subtotal = ₹' + gstExc.subtotal + ', GST = ₹' + gstExc.gstAmount + ', Total = ₹' + gstExc.totalAmount);
    if (gstExc.subtotal !== 200 || gstExc.gstAmount !== 36 || gstExc.totalAmount !== 236) {
      throw new Error(`GST Excluded calculation mismatch: ${JSON.stringify(gstExc)}`);
    }

    // Case C: GST OFF (Flat ₹100, GST ₹0, Total ₹100)
    const gstOff = calculateGst({ unitPrice: 100, quantity: 3, gstMode: 'OFF' });
    console.log('  Case C (GST OFF on 3 x ₹100): Subtotal = ₹' + gstOff.subtotal + ', GST = ₹' + gstOff.gstAmount + ', Total = ₹' + gstOff.totalAmount);
    if (gstOff.subtotal !== 300 || gstOff.gstAmount !== 0 || gstOff.totalAmount !== 300) {
      throw new Error(`GST OFF calculation mismatch: ${JSON.stringify(gstOff)}`);
    }
    console.log('✅ GST Calculation Engine passed!\n');

    // 2. Test Pass Style Persistence & Layout
    console.log('[Test 2] Creating and Persisting Custom Pass Style...');
    const customElements = [
      { id: 'el1', type: 'text', field: 'event_name', label: 'Event Name', x: 50, y: 40, width: 700, height: 50, fontSize: 32, fontColor: '#FFFFFF', textAlign: 'center' },
      { id: 'el2', type: 'text', field: 'category_name', label: 'Tier', x: 50, y: 110, width: 700, height: 40, fontSize: 24, fontColor: '#F59E0B', textAlign: 'center' },
      { id: 'el3', type: 'text', field: 'customer_name', label: 'Holder', x: 50, y: 180, width: 700, height: 35, fontSize: 20, fontColor: '#FFFFFF', textAlign: 'center' },
      { id: 'el4', type: 'barcode', field: 'barcode', label: 'Entry Barcode', x: 150, y: 300, width: 500, height: 120, isVisible: true },
      { id: 'el5', type: 'text', field: 'pass_code', label: 'Pass Code', x: 50, y: 450, width: 700, height: 30, fontSize: 22, fontColor: '#38BDF8', textAlign: 'center' },
      { id: 'el6', type: 'text', field: 'sponsor', label: 'Sponsor', x: 50, y: 520, width: 700, height: 30, fontSize: 16, fontColor: '#E2E8F0', textAlign: 'center' }
    ];

    const style = await createStyle({
      eventId: 1,
      name: 'VIP Gold Holographic Pass',
      description: 'Gold tier pass style with centered barcode',
      canvasWidth: 800,
      canvasHeight: 1200,
      elementsConfig: customElements,
      isDefault: true,
      userId: 1,
      userName: 'Super Administrator'
    });

    console.log(`- Created Style ID: ${style.id} (${style.name})`);
    if (!style.id || style.elements_config.length !== 6) {
      throw new Error('Failed to create or parse pass style layout');
    }
    console.log('✅ Pass Style created and elements JSON verified!\n');

    // 3. Test Full Customer Billing, Pass Generation, Barcode Attachment & PDF Output
    console.log('[Test 3] Executing Customer Billing & Issuing Live Pass with Dynamic Barcode...');
    const billingResult = await issuePassesAndBill({
      eventId: 1,
      categoryId: 1,
      styleId: style.id,
      customerName: 'Aarav Sharma',
      customerEmail: 'aarav.sharma@example.com',
      customerPhone: '+91 98765 12345',
      sponsorName: 'TechCorp India',
      quantity: 2,
      unitPrice: 250,
      gstMode: 'INCLUDED',
      gstRate: 18,
      includePassCodeOnBill: true,
      sendVia: 'BOTH',
      senderName: 'Expo Operations Team',
      emailSubject: 'Corporate Expo 2026 — Your VIP Passes',
      userId: 1,
      userName: 'Super Administrator'
    });

    console.log(`- Invoice Number: ${billingResult.billing.bill_number}`);
    console.log(`- Generated Pass Codes: ${billingResult.passes.map(p => p.code).join(', ')}`);
    console.log(`- Pass PDF Generated (${Buffer.from(billingResult.passPdfBase64, 'base64').length} bytes)`);
    console.log(`- Bill PDF Generated (${Buffer.from(billingResult.billPdfBase64, 'base64').length} bytes)`);
    console.log(`- WhatsApp URL Generated: ${billingResult.whatsappUrl ? 'YES' : 'NO'}`);

    if (billingResult.passes.length !== 2) {
      throw new Error(`Expected 2 passes, got ${billingResult.passes.length}`);
    }
    if (!billingResult.passPdfBase64 || !billingResult.billPdfBase64) {
      throw new Error('Failed to generate Pass or Bill PDF base64');
    }
    console.log('✅ Customer Billing & PDF generation passed!\n');

    // 4. Test Scanner Validation of Newly Issued Styled Pass
    console.log('[Test 4] Testing Scanner Entry on Newly Issued Pass...');
    const issuedPassCode = billingResult.passes[0].code;
    const scanTime = new Date('2026-10-02T05:00:00Z'); // 10:30 AM IST (valid date)
    
    const scanRes = await processScan({
      code: issuedPassCode,
      deviceId: 'GATE-VIP-01',
      customNow: scanTime
    });

    console.log(`- Gate Scan for ${issuedPassCode} Result: ${scanRes.result} (${scanRes.message})`);
    if (scanRes.result !== 'approved') {
      throw new Error(`Expected approved scan, got: ${scanRes.result}`);
    }
    console.log('✅ Newly issued pass scanned and APPROVED at gate with 100% HMAC validity!\n');

    // Clean up test style
    await deleteStyle(style.id, { eventId: 1, isSuperAdmin: true });
    console.log('================================================================');
    console.log('         ALL PASS DESIGNER & BILLING TESTS PASSED 100%!         ');
    console.log('================================================================');
    process.exit(0);
  } catch (err) {
    console.error('\n❌ Test Failure:', err.message);
    process.exit(1);
  }
}

runTests();
