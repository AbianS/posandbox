// Builds the representative receipt used by tests, the e2e suite and the printer self-test.
// It is produced by a real POS encoder (ReceiptPrinterEncoder) for the TM-T20III profile.
// Usage: node scripts/sample-ticket.ts > fixtures/sample-ticket.bin
import ReceiptPrinterEncoder from '@point-of-sale/receipt-printer-encoder';

const logo = (() => {
  const width = 192, height = 64, data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const dx = x - 32, dy = y - 32;
      const ink = dx * dx + dy * dy < 26 * 26 && dx * dx + dy * dy > 16 * 16 || (x > 70 && x < 186 && y > 22 && y < 42 && (x - 70) % 24 < 18);
      if (ink) data.fill(0, (y * width + x) * 4, (y * width + x) * 4 + 3);
    }
  return { width, height, data };
})();

const encoder = new ReceiptPrinterEncoder({ printerModel: 'epson-tm-t20iii', columns: 48 });
const bytes = encoder
  .initialize()
  .codepage('auto')
  .align('center')
  .image(logo, 192, 64, 'threshold')
  .newline()
  .bold(true).size(2, 2).line('POSANDBOX CAFE').size(1, 1).bold(false)
  .line('12 Mayor St · 35001 Las Palmas')
  .line('Tax ID B12345678')
  .newline()
  .align('left')
  .table(
    [{ width: 34, align: 'left' }, { width: 13, align: 'right' }],
    [
      ['2 x Coffee with milk', '€3.20'],
      ['1 x Ham sandwich', '€4.50'],
      ['1 x Orange juice', '€2.80'],
    ],
  )
  .rule()
  .bold(true).table([{ width: 34, align: 'left' }, { width: 13, align: 'right' }], [['TOTAL', '€10.50']]).bold(false)
  .underline(true).line('VAT included (10%)').underline(false)
  .newline()
  .align('center')
  .barcode('{B12345678', 'code128', 60)
  .newline()
  .qrcode('https://posandbox.dev/ticket/0001', 1, 6, 'm')
  .line('Thank you! Please ask if you need an invoice.')
  .newline()
  .cut('partial')
  .encode();

process.stdout.write(bytes);
