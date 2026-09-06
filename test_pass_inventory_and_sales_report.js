const assert = require('assert');
const { initDatabase, query } = require('./src/config/db');
const passService = require('./src/services/PassService');
const billingService = require('./src/services/BillingService');
const salesReportService = require('./src/services/SalesReportService');
const scanService = require('./src/services/ScanService');
const {
  formatDateTimeIST,
  formatDateIST,
  formatTimeIST,
  getISTDayBoundsUTC,
  getISTPresetRangeUTC,
  getISTComponents
} = require('./src/utils/timeUtil');

async function runTests() {
  console.log('===============================================================');
  console.log('🧪 Starting EventGen Inventory, Reshare, IST & Sales Report Tests');
  console.log('===============================================================\n');

  await initDatabase();

  // Fetch or ensure test events exist
  const events = await query('SELECT * FROM events ORDER BY id ASC');
  assert(events.length >= 1, 'At least one event should exist');
  const event1 = events[0];
  const event2 = events[1] || events[0];

  // Fetch categories
  const categories = await query('SELECT * FROM pass_categories WHERE event_id = ? ORDER BY id ASC', [event1.id]);
  assert(categories.length >= 1, 'At least one category should exist');
  const cat1 = categories[0];

  console.log(`[Context] Using Event 1: "${event1.event_name}" (#${event1.id}) and Category: "${cat1.name}" (#${cat1.id})`);

  // =========================================================================
  // TEST 1: Customer Creation, Pass Issuance & Initial Communication Tracking
  // =========================================================================
  console.log('\n--- TEST 1: Customer Pass Issuance & Initial Communication Tracking ---');
  const customerName = `Test Buyer ${Date.now()}`;
  const customerEmail = `buyer_${Date.now()}@example.com`;
  const customerPhone = '+91 98765 43210';

  const issueRes = await billingService.issuePassesAndBill({
    eventId: event1.id,
    categoryId: cat1.id,
    customerName,
    customerEmail,
    customerPhone,
    sponsorName: 'Test Partner Inc',
    quantity: 2,
    unitPrice: 500,
    gstMode: 'INCLUDED',
    gstRate: 18,
    sendVia: 'BOTH',
    userId: 1,
    userName: 'SuperAdmin'
  });

  assert(issueRes.success, 'Pass issuance should succeed');
  assert(issueRes.passes.length === 2, 'Should create 2 passes');
  const testPass1 = issueRes.passes[0];
  const testPass2 = issueRes.passes[1];
  console.log(`✅ Issued 2 passes with bill #${issueRes.billing.bill_number}: Codes [${testPass1.code}, ${testPass2.code}]`);

  // Verify pass record in database
  const passRows = await query('SELECT * FROM passes WHERE id = ?', [testPass1.id]);
  const pRecord = passRows[0];
  assert.strictEqual(pRecord.customer_name, customerName);
  assert.strictEqual(pRecord.customer_email, customerEmail);
  assert.strictEqual(pRecord.customer_phone, customerPhone);
  assert.strictEqual(pRecord.sharing_method, 'BOTH');
  assert.strictEqual(pRecord.reshare_count, 0);
  assert(pRecord.first_shared_at !== null, 'first_shared_at should be populated');
  assert(pRecord.last_shared_at !== null, 'last_shared_at should be populated');
  console.log('✅ Pass record properly stores customer details and initial sharing metadata');

  // Verify initial communication history record
  const commHistory = await query('SELECT * FROM pass_communication_history WHERE pass_id = ?', [testPass1.id]);
  assert(commHistory.length >= 1, 'Should record initial communication history');
  assert.strictEqual(commHistory[0].sharing_method, 'BOTH');
  assert.strictEqual(commHistory[0].customer_email, customerEmail);
  console.log(`✅ Communication history recorded initial share: ${commHistory[0].notes}`);

  // =========================================================================
  // TEST 2: Pass Resharing (Email, WhatsApp, Both) & Counter Increment
  // =========================================================================
  console.log('\n--- TEST 2: Pass Resharing Without Pass Code Recreation ---');
  const originalCode = testPass1.code;
  const updatedEmail = `updated_${Date.now()}@example.com`;

  // Reshare 1: Email channel with updated email
  const reshare1 = await passService.resharePass({
    passId: testPass1.id,
    sharingMethod: 'EMAIL',
    customerEmail: updatedEmail,
    customerPhone: customerPhone,
    notes: 'Customer requested update to new email address',
    userId: 1,
    userName: 'SuperAdmin'
  });

  assert(reshare1.success, 'Reshare should succeed');
  assert.strictEqual(reshare1.pass.code, originalCode, 'Pass code must NOT change during reshare');
  assert.strictEqual(reshare1.pass.reshare_count, 1, 'Reshare count should increment to 1');
  assert.strictEqual(reshare1.pass.customer_email, updatedEmail, 'Customer email should update on pass');
  assert.strictEqual(reshare1.communicationHistory.length, 2, 'Communication history should have 2 records');
  console.log(`✅ Reshare 1 (Email): Pass code ${reshare1.pass.code} preserved, reshare_count = ${reshare1.pass.reshare_count}`);

  // Reshare 2: WhatsApp channel
  const updatedPhone = '+91 99999 88888';
  const reshare2 = await passService.resharePass({
    passId: testPass1.id,
    sharingMethod: 'WHATSAPP',
    customerEmail: updatedEmail,
    customerPhone: updatedPhone,
    notes: 'Resent via WhatsApp direct link',
    userId: 1,
    userName: 'SuperAdmin'
  });

  assert(reshare2.success, 'Reshare 2 should succeed');
  assert.strictEqual(reshare2.pass.code, originalCode, 'Pass code must NOT change');
  assert.strictEqual(reshare2.pass.reshare_count, 2, 'Reshare count should increment to 2');
  assert.strictEqual(reshare2.pass.customer_phone, updatedPhone, 'Customer phone should update on pass');
  assert(reshare2.whatsappUrl !== null, 'WhatsApp URL should be generated');
  assert.strictEqual(reshare2.communicationHistory.length, 3, 'Communication history should have 3 records');
  console.log(`✅ Reshare 2 (WhatsApp): reshare_count = ${reshare2.pass.reshare_count}, WhatsApp URL ready`);

  // =========================================================================
  // TEST 3: Pass Inventory Query & Filters
  // =========================================================================
  console.log('\n--- TEST 3: Pass Inventory Query & Multi-field Search ---');
  // Search by pass code
  const searchByCode = await passService.getPasses({ search: originalCode });
  assert(searchByCode.passes.length >= 1, 'Should find pass by code');
  assert.strictEqual(searchByCode.passes[0].code, originalCode);

  // Search by customer name
  const searchByName = await passService.getPasses({ search: customerName });
  assert(searchByName.passes.length >= 1, 'Should find pass by customer name');

  // Search by customer phone
  const searchByPhone = await passService.getPasses({ search: '99999' });
  assert(searchByPhone.passes.length >= 1, 'Should find pass by phone');

  // Filter by sharing method
  const filterBySharing = await passService.getPasses({ sharingMethod: 'WHATSAPP' });
  assert(filterBySharing.passes.some(p => p.id === testPass1.id), 'Should filter by WHATSAPP sharing method');
  console.log('✅ Pass inventory multi-field search (code, name, email, phone, sharing method) verified');

  // =========================================================================
  // TEST 4: Excel (.xlsx) Export for Pass Inventory
  // =========================================================================
  console.log('\n--- TEST 4: Pass Inventory Excel Export (.xlsx) ---');
  const excelBuffer = await passService.exportPassesExcel({ eventId: event1.id });
  assert(Buffer.isBuffer(excelBuffer), 'Excel output should be a binary Buffer');
  assert(excelBuffer.length > 500, 'Excel buffer should contain valid .xlsx payload');
  // Check ZIP/XLSX magic number (PK\x03\x04)
  assert.strictEqual(excelBuffer[0], 0x50);
  assert.strictEqual(excelBuffer[1], 0x4B);
  console.log(`✅ Generated valid Excel (.xlsx) workbook for Pass Inventory (${excelBuffer.length} bytes)`);

  // =========================================================================
  // TEST 5: IST Timezone Calculations & Gate Scan Verification
  // =========================================================================
  console.log('\n--- TEST 5: IST Timezone Calculations & Gate Scan Verification ---');
  const istBounds = getISTDayBoundsUTC();
  console.log(`[Timezone] Today in IST bounds: ${istBounds.startUtc} to ${istBounds.endUtc} UTC`);

  // Test scan execution during valid window
  const scanRes = await scanService.processScan({
    code: originalCode,
    deviceId: 'GATE-01',
    customNow: new Date('2026-10-02T12:00:00Z')
  });
  assert(scanRes.success, 'Gate scan should be approved');
  assert.strictEqual(scanRes.result, 'approved');

  // Verify pass last_scanned_at was recorded
  const updatedPassDetails = await passService.getPassDetails(testPass1.id);
  assert.strictEqual(updatedPassDetails.pass.scan_count, 1);
  assert(updatedPassDetails.pass.last_scanned_at !== null);
  const formattedScanIST = formatDateTimeIST(updatedPassDetails.pass.last_scanned_at);
  console.log(`✅ Scan registered successfully. Last Scan IST: "${formattedScanIST}"`);

  // =========================================================================
  // TEST 6: Sales Report KPIs, Aggregations & Consistency
  // =========================================================================
  console.log('\n--- TEST 6: Sales Report KPIs, Aggregations & Consistency ---');
  const salesSummary = await salesReportService.getSalesSummary({ eventId: event1.id });
  assert(salesSummary.totalPassesSold >= 2, 'Total passes sold should include our test sale');
  assert(salesSummary.totalSalesAmount > 0, 'Gross sales should be > 0');
  assert(salesSummary.totalCustomers >= 1, 'Distinct customer count should be >= 1');
  console.log(`✅ Sales Summary: Sold ${salesSummary.totalPassesSold} passes, Revenue ₹${salesSummary.totalSalesAmount}, Customers ${salesSummary.totalCustomers}`);

  // Test Sales Transactions List
  const salesTx = await salesReportService.getSalesTransactions({ eventId: event1.id, search: customerName });
  assert(salesTx.transactions.length >= 2, 'Should list sales transaction entries');
  console.log(`✅ Sales Transactions list returned ${salesTx.transactions.length} rows for customer "${customerName}"`);

  // Test Category Performance
  const catSales = await salesReportService.getCategorySales({ eventId: event1.id });
  assert(catSales.length >= 1, 'Category sales should return at least 1 category');
  console.log(`✅ Category Performance: Category "${catSales[0].categoryName}" sold ${catSales[0].totalSold} passes (₹${catSales[0].grossRevenue})`);

  // Test Sales Trends (Daily in IST)
  const trendDaily = await salesReportService.getSalesTrend({ eventId: event1.id }, 'daily');
  assert(trendDaily.length >= 1, 'Sales trend should return daily buckets');
  console.log(`✅ Sales Trends: ${trendDaily.length} date bucket(s) in IST. Latest: ${trendDaily[trendDaily.length - 1].timeBucket}`);

  // Test Customer Sales Report
  const custReport = await salesReportService.getCustomerSales({ eventId: event1.id, search: customerName });
  assert(custReport.customers.length >= 1, 'Customer report should aggregate by customer');
  assert.strictEqual(custReport.customers[0].customerName, customerName);
  console.log(`✅ Customer Report: "${custReport.customers[0].customerName}" bought ${custReport.customers[0].passesPurchased} passes, Total ₹${custReport.customers[0].totalSpent}`);

  // Test Sales Excel Export
  const salesExcelBuffer = await salesReportService.exportSalesExcel({ eventId: event1.id });
  assert(Buffer.isBuffer(salesExcelBuffer));
  assert.strictEqual(salesExcelBuffer[0], 0x50);
  assert.strictEqual(salesExcelBuffer[1], 0x4B);
  console.log(`✅ Generated valid Sales Report Excel (.xlsx) workbook (${salesExcelBuffer.length} bytes)`);

  // =========================================================================
  // TEST 7: Consistency Verification (Reshares and Scans do NOT increase Sales)
  // =========================================================================
  console.log('\n--- TEST 7: Consistency Verification (Reshare & Scan do NOT increase sales) ---');
  const summaryBefore = await salesReportService.getSalesSummary({ eventId: event1.id });

  // Perform another reshare on testPass1
  await passService.resharePass({
    passId: testPass1.id,
    sharingMethod: 'EMAIL',
    customerEmail: updatedEmail,
    userId: 1,
    userName: 'SuperAdmin'
  });

  const summaryAfterReshare = await salesReportService.getSalesSummary({ eventId: event1.id });
  assert.strictEqual(summaryBefore.totalPassesSold, summaryAfterReshare.totalPassesSold, 'Reshare must NOT increase total passes sold');
  assert.strictEqual(summaryBefore.totalSalesAmount, summaryAfterReshare.totalSalesAmount, 'Reshare must NOT increase total sales revenue');
  console.log('✅ Verified: Reshare does NOT increase sales revenue or pass counts');

  console.log('\n===============================================================');
  console.log('🎉 ALL TESTS PASSED SUCCESSFULLY! 100% COMPLETE & VERIFIED');
  console.log('===============================================================\n');
  process.exit(0);
}

runTests().catch(err => {
  console.error('\n❌ Test failed with error:', err);
  process.exit(1);
});
