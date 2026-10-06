import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Parser } from './escpos/parser.ts';
import { PrintEngine, type EngineHooks } from './print-engine.ts';
import { Bitmap } from './render/bitmap.ts';
import { printerFonts } from './render/fonts.ts';

const ESC = 0x1b, GS = 0x1d, LF = 0x0a;
const bytes = (...parts: (number | string | number[])[]) =>
  Uint8Array.from(parts.flatMap((p) => (typeof p === 'string' ? [...Buffer.from(p, 'latin1')] : Array.isArray(p) ? p : [p])));

function run(data: Uint8Array, width = 576) {
  const events: string[] = [];
  const sent: number[] = [];
  let paper = new Bitmap(width);
  const cuts: Bitmap[] = [];
  const hooks: EngineHooks = {
    paper: () => paper,
    cut: () => {
      events.push('cut');
      cuts.push(paper);
      paper = new Bitmap(width);
    },
    transmit: (b) => sent.push(...b),
  };
  const engine = new PrintEngine(width, hooks);
  const parser = new Parser();
  parser.push(data);
  const results: string[] = [];
  for (let t = parser.next(); t; t = parser.next()) results.push(`${t.kind === 'text' ? 'text' : t.name}:${engine.execute(t)}`);
  return { paper: () => paper, cuts, events, sent, results, engine };
}

/** Bounding box of the ink: [minX, minY, maxX, maxY] or null. */
function ink(bmp: Bitmap, y0 = 0, y1 = bmp.height) {
  let box: number[] | null = null;
  for (let y = y0; y < y1; y++)
    for (let x = 0; x < bmp.width; x++)
      if (bmp.get(x, y)) box = box ? [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x), Math.max(box[3], y)] : [x, y, x, y];
  return box;
}

test('a line of Font A text is 12x24 per character and feeds the default 30-dot line spacing', () => {
  const { paper } = run(bytes('HH', LF));
  assert.equal(paper().height, 30);
  const [minX, minY, maxX, maxY] = ink(paper())!;
  assert.ok(minX >= 0 && maxX < 24 && maxX >= 12, `x ${minX}-${maxX}`);
  assert.ok(minY >= 0 && maxY < 24, `y ${minY}-${maxY}`);
});

test('LF on an empty line feeds one line', () => {
  assert.equal(run(bytes(LF, LF)).paper().height, 60);
});

test('centre and right justification use the printable width', () => {
  const center = ink(run(bytes(ESC, 'a', 1, 'H', LF)).paper())!;
  assert.ok(center[0] >= 282 && center[2] < 294, `centre x ${center[0]}-${center[2]}`);
  const right = ink(run(bytes(ESC, 'a', 2, 'H', LF)).paper())!;
  assert.ok(right[0] >= 564 && right[2] <= 575, `right x ${right[0]}-${right[2]}`);
});

test('GS ! scales characters and the line grows to fit them', () => {
  const { paper } = run(bytes(GS, '!', 0x11, 'H', LF));
  const [, , maxX, maxY] = ink(paper())!;
  assert.ok(maxX >= 12 && maxX < 24);
  assert.ok(maxY >= 24 && maxY < 48);
  assert.equal(paper().height, 48);
});

test('ESC ! selects Font B (9x17)', () => {
  const { paper } = run(bytes(ESC, '!', 1, 'HHHH', LF));
  const [, , maxX, maxY] = ink(paper())!;
  assert.ok(maxX < 36 && maxX >= 27, `maxX ${maxX}`);
  assert.ok(maxY < 17);
});

test('text wraps when it exceeds the printable width (48 Font A columns on 80 mm)', () => {
  assert.equal(run(bytes('x'.repeat(48), LF)).paper().height, 30);
  assert.equal(run(bytes('x'.repeat(49), LF)).paper().height, 60);
  assert.equal(run(bytes('x'.repeat(35), LF), 420).paper().height, 30);
  assert.equal(run(bytes('x'.repeat(36), LF), 420).paper().height, 60);
});

test('ESC 3 counts half dots by default; after GS P 203 203 it counts whole dots', () => {
  assert.equal(run(bytes(ESC, '3', 40, LF)).paper().height, 20);
  assert.equal(run(bytes(GS, 'P', 203, 203, ESC, '3', 24, LF)).paper().height, 24);
  assert.equal(run(bytes(ESC, '3', 40, ESC, '2', LF)).paper().height, 30);
});

test('ESC J and ESC d feed paper', () => {
  assert.equal(run(bytes(ESC, 'J', 100)).paper().height, 50);
  assert.equal(run(bytes(ESC, 'd', 3)).paper().height, 90);
});

test('ESC @ resets print modes but keeps what is already printed', () => {
  const { paper } = run(bytes(GS, '!', 0x11, 'H', LF, ESC, '@', 'H', LF));
  assert.equal(paper().height, 48 + 30);
});

test('ESC * 24-dot double density stacks into a continuous image with 24-dot spacing', () => {
  const column = [0xff, 0xff, 0xff];
  const img = bytes(GS, 'P', 203, 203, ESC, '3', 24, ESC, '*', 33, 2, 0, column, column, LF, ESC, '*', 33, 2, 0, column, column, LF);
  const { paper } = run(img);
  assert.equal(paper().height, 48);
  assert.deepEqual(ink(paper()), [0, 0, 1, 47]);
});

test('ESC * 8-dot single density is stretched to 203 dpi (x2 wide, x3 tall)', () => {
  const { paper } = run(bytes(ESC, '*', 0, 1, 0, 0x80, LF));
  assert.deepEqual(ink(paper()), [0, 0, 1, 2]);
});

test('GS v 0 prints a raster image, honouring justification', () => {
  // 1 byte wide (8 dots), 2 rows: 10000001 / 01111110
  const { paper } = run(bytes(ESC, 'a', 1, GS, 'v', '0', 0, 1, 0, 2, 0, 0x81, 0x7e));
  assert.equal(paper().height, 2);
  assert.deepEqual(ink(paper()), [284, 0, 291, 1]);
  assert.equal(paper().get(284, 0), true);
  assert.equal(paper().get(285, 0), false);
});

test('code tables: the euro sign in PC858, PC857 and WPC1252, ñ in PC437', () => {
  const { A } = printerFonts();
  const glyphOf = (cp: number) => A.regular.glyph(cp)!;
  const firstChar = (b: Bitmap) => {
    const dots = new Uint8Array(12 * 24);
    for (let y = 0; y < 24; y++) for (let x = 0; x < 12; x++) dots[y * 12 + x] = b.get(x, y) ? 1 : 0;
    return dots;
  };
  assert.deepEqual(firstChar(run(bytes(ESC, 't', 19, 0xd5, LF)).paper()), glyphOf(0x20ac));
  assert.deepEqual(firstChar(run(bytes(ESC, 't', 16, 0x80, LF)).paper()), glyphOf(0x20ac));
  assert.deepEqual(firstChar(run(bytes(ESC, 't', 13, 0xd5, LF)).paper()), glyphOf(0x20ac));
  assert.deepEqual(firstChar(run(bytes(0xa4, LF)).paper()), glyphOf(0xf1));
});

test('emphasis uses the bold face, underline draws under the characters', () => {
  const plain = ink(run(bytes('H', LF)).paper())!;
  const under = ink(run(bytes(ESC, '-', 1, 'H', LF)).paper())!;
  assert.ok(under[3] > plain[3], 'underline below glyph');
  const boldDots = (b: Bitmap) => { let n = 0; for (let y = 0; y < 24; y++) for (let x = 0; x < 12; x++) n += b.get(x, y) ? 1 : 0; return n; };
  assert.ok(boldDots(run(bytes(ESC, 'E', 1, 'H', LF)).paper()) > boldDots(run(bytes('H', LF)).paper()));
});

test('GS B reverse prints white on black', () => {
  const { paper } = run(bytes(GS, 'B', 1, ' ', LF));
  assert.equal(paper().get(0, 0), true);
  assert.equal(paper().get(11, 23), true);
});

test('GS k CODE128 prints bars of the selected module width and height, with HRI below', () => {
  const { paper } = run(bytes(GS, 'h', 50, GS, 'w', 2, GS, 'H', 2, GS, 'k', 73, 4, '{B12'));
  const bars = ink(paper(), 0, 50)!;
  assert.equal(bars[1], 0);
  assert.equal(bars[3], 49);
  // CODE128 "{B12": start(11) + 2 chars(22) + check(11) + stop(13) = 57 modules * 2 dots
  assert.equal(bars[2] - bars[0] + 1, 57 * 2 - 0);
  assert.ok(paper().height > 50 + 17, 'HRI printed below');
});

test('GS k with invalid data prints nothing', () => {
  assert.equal(run(bytes(GS, 'k', 67, 3, 'abc')).paper().height, 0);
});

test('QR code: store then print, module size from GS ( k 167', () => {
  const qr = bytes(
    GS, '(', 'k', 3, 0, 49, 67, 4, // size 4
    GS, '(', 'k', 3, 0, 49, 69, 49, // EC M
    GS, '(', 'k', 7, 0, 49, 80, 48, 'test', // store
    GS, '(', 'k', 3, 0, 49, 81, 48, // print
  );
  const { paper } = run(qr);
  const [minX, minY, maxX, maxY] = ink(paper())!;
  // version 1 = 21 modules * 4 dots
  assert.equal(maxX - minX + 1, 84);
  assert.equal(maxY - minY + 1, 84);
});

test('GS V cuts (after feeding n for m = 65/66); ESC i / ESC m cut too', () => {
  const r = run(bytes('A', LF, GS, 'V', 66, 10, 'B', LF, ESC, 'i', ESC, 'm'));
  assert.deepEqual(r.events, ['cut', 'cut', 'cut']);
  assert.equal(r.cuts[0].height, 30 + 5);
  assert.equal(r.cuts[1].height, 30);
});

test('reports support for each command it executes', () => {
  const r = run(bytes(ESC, 'E', 1, ESC, 'R', 7, GS, '*', 1, 1, [0, 0, 0, 0, 0, 0, 0, 0], 'A'));
  assert.deepEqual(r.results, ['ESC E:supported', 'ESC R:ignored', 'GS *:unsupported', 'text:supported']);
});

test('the representative ticket renders with logo, text, barcode, QR and a cut', () => {
  const ticket = new Uint8Array(readFileSync(new URL('../../../fixtures/sample-ticket.bin', import.meta.url)));
  const r = run(ticket);
  assert.deepEqual(r.events, ['cut']);
  const printed = r.cuts[0];
  assert.ok(printed.height > 600 && printed.height < 1600, `height ${printed.height}`);
  assert.ok(!r.results.some((x) => x.endsWith(':unsupported') || x.endsWith(':unknown')), r.results.filter((x) => !x.endsWith('supported')).join());
});

test('ESC SP adds right-side spacing to every character (doubled in double width)', () => {
  const [, , maxX] = ink(run(bytes(ESC, ' ', 6, 'HH', LF)).paper())!;
  assert.ok(maxX >= 18 && maxX < 30, `second char starts after 12 + 6 dots, maxX ${maxX}`);
});

test('ESC $ and ESC \\ move the print position on the line', () => {
  const abs = ink(run(bytes(ESC, '$', 100, 0, 'H', LF)).paper())!;
  assert.ok(abs[0] >= 100 && abs[0] < 112);
  const rel = ink(run(bytes('H', ESC, '\\', 50, 0, 'H', LF)).paper())!;
  assert.ok(rel[2] >= 62 && rel[2] < 74, `relative maxX ${rel[2]}`);
});

test('ESC G double-strike prints heavier, like emphasis', () => {
  const dots = (b: Bitmap) => { let n = 0; for (let y = 0; y < 24; y++) for (let x = 0; x < 12; x++) n += b.get(x, y) ? 1 : 0; return n; };
  assert.ok(dots(run(bytes(ESC, 'G', 1, 'H', LF)).paper()) > dots(run(bytes('H', LF)).paper()));
});

test('ESC M selects Font B', () => {
  const [, , , maxY] = ink(run(bytes(ESC, 'M', 1, 'H', LF)).paper())!;
  assert.ok(maxY < 17);
});

test('GS L and GS W set the left margin and the printable area used by justification', () => {
  const left = ink(run(bytes(GS, 'L', 40, 0, 'H', LF)).paper())!;
  assert.ok(left[0] >= 40 && left[0] < 52);
  const centred = ink(run(bytes(GS, 'W', 200, 0, ESC, 'a', 1, 'H', LF)).paper())!;
  assert.ok(centred[0] >= 94 && centred[2] < 106, `centred in 200 dots: ${centred[0]}-${centred[2]}`);
});

test('GS f selects the HRI font (Font B is shorter)', () => {
  const hri = (font: number) => run(bytes(GS, 'h', 20, GS, 'H', 2, GS, 'f', font, GS, 'k', 73, 4, '{B12')).paper().height;
  assert.equal(hri(0) - hri(1), 24 - 17);
});

test('ESC { is reported as not emulated rather than silently claimed', () => {
  assert.deepEqual(run(bytes(ESC, '{', 1)).results, ['ESC {:unsupported']);
});
