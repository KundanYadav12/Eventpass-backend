/**
 * Dedicated Direct Physical Barcode Test for TSC TE244
 * 
 * Generates exact TSPL for 50mm x 50mm label with Code 128 barcode and human-readable text.
 */

const { printRawTspl, getDetailedPrinterDiagnostics } = require('./src/utils/printerDriver');

// Exact 38mm x 50mm Code 128 Barcode TSPL payload
function buildSingleBarcodeTspl(barcodeValue = '55KDBD2') {
  const commands = [
    'SIZE 38 mm, 50 mm',
    'GAP 3 mm, 0 mm',
    'SPEED 4',
    'DENSITY 8',
    'DIRECTION 1',
    'REFERENCE 0,0',
    'SET TEAR ON',
    'CLS',
    `BARCODE 16,100,"128",130,0,0,2,4,"${barcodeValue}"`,
    `TEXT 16,265,"3",0,1,1,"PASS CODE: ${barcodeValue}"`,
    'BOX 8,8,294,390,2',
    'PRINT 1,1'
  ];

  return commands.join('\r\n') + '\r\n';
}

async function runDirectTest() {
  const printerName = 'TSC TE244';
  const barcodeValue = '55KDBD2';

  console.log('========================================================');
  console.log('   TSC TE244 PHYSICAL BARCODE PRINT TEST (50mm x 50mm)  ');
  console.log('========================================================');
  console.log(`Target Printer : ${printerName}`);
  console.log(`Barcode Type   : Code 128 ("128")`);
  console.log(`Barcode Value  : ${barcodeValue}`);
  console.log(`Stock Size     : 50mm x 50mm`);
  console.log('--------------------------------------------------------');

  const diagBefore = await getDetailedPrinterDiagnostics(printerName);
  console.log('Pre-Print Diagnostics:', JSON.stringify(diagBefore, null, 2));

  const tsplPayload = buildSingleBarcodeTspl(barcodeValue);
  console.log('\n--- EXACT RAW TSPL PAYLOAD (CRLF) ---');
  console.log(tsplPayload);
  console.log('-------------------------------------\n');

  try {
    const result = await printRawTspl(printerName, tsplPayload, 'TSC_Single_Barcode_Test');
    console.log('Spooler Result:', result);

    const diagAfter = await getDetailedPrinterDiagnostics(printerName);
    console.log('\nPost-Print Diagnostics:', JSON.stringify(diagAfter, null, 2));

    console.log('\n========================================================');
    console.log('JOB DISPATCHED TO WINDOWS SPOOLER OVER USB PORT.');
    console.log('Check the physical TSC TE244 printer:');
    console.log('- If a label feeds and prints: Physical test PASSED.');
    console.log('- If LED blinks blue/green: Press physical FEED button once or run calibration.');
    console.log('========================================================');
  } catch (err) {
    console.error('❌ Print failed:', err.message);
  }
}

if (require.main === module) {
  runDirectTest();
}

module.exports = {
  buildSingleBarcodeTspl,
  runDirectTest
};
