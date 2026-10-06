import QRCode from 'qrcode';
import type { Support } from '../../shared/contract.ts';
import { CODE_PAGES } from './escpos/codepages.ts';
import type { Token } from './escpos/parser.ts';
import { barcodeType, encodeBarcode } from './render/barcode.ts';
import type { Bitmap } from './render/bitmap.ts';
import { printerFonts, type PrinterFont } from './render/fonts.ts';

export interface EngineHooks {
  /** Paper currently under the print head. */
  paper(): Bitmap;
  cut(): void;
  transmit(bytes: Uint8Array): void;
}

/** Something placed on the current line, drawn when the line is printed (bottom-aligned). */
interface Item {
  x: number;
  width: number;
  height: number;
  draw(paper: Bitmap, x: number, bottom: number): void;
}

const DOTS_PER_INCH = 203;
const DEFAULT_LINE_SPACING = 30;
const QR_LEVELS = ['L', 'M', 'Q', 'H'] as const;

function initialModes(width: number) {
  return {
    font: 'A' as 'A' | 'B',
    bold: false,
    doubleStrike: false,
    underline: 0,
    widthMul: 1,
    heightMul: 1,
    reverse: false,
    align: 0,
    lineSpacing: DEFAULT_LINE_SPACING,
    charSpacing: 0,
    leftMargin: 0,
    areaWidth: width,
    codePage: 0,
    unitX: 1, // dots per horizontal motion unit (GS P x = 203)
    unitY: 0.5, // dots per vertical motion unit (GS P y = 406)
    barcode: { height: 162, module: 3, hri: 0, hriFont: 'A' as 'A' | 'B' },
    qr: { module: 3, level: 'L' as (typeof QR_LEVELS)[number], data: null as Uint8Array | null },
  };
}

/**
 * Standard-mode print engine of the TM-T20III profile: keeps the print modes and the line buffer,
 * and burns dots on the paper. Device concerns (status, faults, drawer) belong to the Printer.
 */
export class PrintEngine {
  readonly width: number;
  readonly hooks: EngineHooks;
  modes: ReturnType<typeof initialModes>;
  #line: Item[] = [];
  #x = 0;

  constructor(width: number, hooks: EngineHooks) {
    this.width = width;
    this.hooks = hooks;
    this.modes = initialModes(width);
  }

  /** True when there is unprinted data in the line buffer. */
  get lineBuffered(): boolean {
    return this.#line.length > 0;
  }

  execute(token: Token): Support {
    if (token.kind === 'text') {
      for (const byte of token.bytes) this.#char(byte);
      return 'supported';
    }
    if (token.kind !== 'command') return 'unknown';
    const b = token.bytes;
    const m = this.modes;
    const n = b[2];
    const u16 = (at: number) => b[at] | (b[at + 1] << 8);
    switch (token.name) {
      case 'LF': this.#printLine(m.lineSpacing); break;
      case 'ESC @': this.modes = initialModes(this.width); this.#line = []; this.#x = 0; break;
      case 'ESC !':
        m.font = n & 0x01 ? 'B' : 'A';
        m.bold = !!(n & 0x08);
        m.heightMul = n & 0x10 ? 2 : 1;
        m.widthMul = n & 0x20 ? 2 : 1;
        m.underline = n & 0x80 ? 1 : 0;
        break;
      case 'ESC SP': m.charSpacing = n * m.unitX; break;
      case 'ESC $': this.#x = Math.round(u16(2) * m.unitX); break;
      case 'ESC \\': this.#x = Math.max(0, this.#x + Math.round(((u16(2) << 16) >> 16) * m.unitX)); break;
      case 'ESC -': m.underline = n % 48 <= 2 ? n % 48 : m.underline; break;
      case 'ESC E': m.bold = !!(n & 1); break;
      case 'ESC G': m.doubleStrike = !!(n & 1); break;
      case 'ESC M': m.font = n & 1 ? 'B' : 'A'; break;
      case 'ESC a': if (n % 48 <= 2) m.align = n % 48; break;
      case 'ESC 2': m.lineSpacing = DEFAULT_LINE_SPACING; break;
      case 'ESC 3': m.lineSpacing = Math.round(n * m.unitY); break;
      case 'ESC J': this.#printLine(Math.round(n * m.unitY)); break;
      case 'ESC d': this.#printLine(n * m.lineSpacing); break;
      case 'ESC t':
        if (!CODE_PAGES[n]) return 'unsupported';
        m.codePage = n;
        break;
      case 'ESC *': this.#bitImage(b); break;
      case 'ESC i': case 'ESC m': this.#cut(0); break;
      case 'GS V': this.#cut(b.length === 4 ? b[3] : 0); break;
      case 'GS !': m.widthMul = ((n >> 4) & 7) + 1; m.heightMul = (n & 7) + 1; break;
      case 'GS B': m.reverse = !!(n & 1); break;
      case 'GS L': if (!this.#line.length) m.leftMargin = Math.min(Math.round(u16(2) * m.unitX), this.width - 1); break;
      case 'GS W': m.areaWidth = Math.max(1, Math.min(Math.round(u16(2) * m.unitX), this.width - m.leftMargin)); break;
      case 'GS P':
        m.unitX = b[2] ? DOTS_PER_INCH / b[2] : 1;
        m.unitY = b[3] ? DOTS_PER_INCH / b[3] : 0.5;
        break;
      case 'GS H': if (n % 48 <= 3) m.barcode.hri = n % 48; break;
      case 'GS f': m.barcode.hriFont = n & 1 ? 'B' : 'A'; break;
      case 'GS h': if (n >= 1) m.barcode.height = n; break;
      case 'GS w': if (n >= 2 && n <= 6) m.barcode.module = n; break;
      case 'GS k': this.#barcode(b); break;
      case 'GS v 0': this.#raster(b); break;
      case 'GS ( k': return this.#qr(b);
      // never claim support for something not executed here (device commands are handled by the Printer)
      default: return token.spec.support === 'supported' ? 'unsupported' : token.spec.support;
    }
    return 'supported';
  }

  // ---- text ----

  #font(): PrinterFont {
    return printerFonts()[this.modes.font];
  }

  #char(byte: number): void {
    const m = this.modes;
    const font = this.#font();
    const face = m.bold || m.doubleStrike ? font.bold : font.regular;
    const page = CODE_PAGES[m.codePage] ?? CODE_PAGES[0];
    const cp = byte < 0x80 ? byte : page.high.codePointAt(byte - 0x80)!;
    const glyph = face.glyph(cp) ?? face.glyph(0x3f)!;
    const { widthMul: sx, heightMul: sy, underline, reverse } = m;
    const cellW = font.width + m.charSpacing;
    const fw = font.width;
    this.#add({
      x: 0,
      width: cellW * sx,
      height: font.height * sy,
      draw: (paper, x0, bottom) => {
        const top = bottom - font.height * sy;
        for (let gy = 0; gy < font.height; gy++) {
          for (let gx = 0; gx < cellW; gx++) {
            let on = gx < fw && glyph[gy * fw + gx] === 1;
            if (underline && gy >= font.height - underline) on = true;
            if (reverse) on = !on;
            if (!on) continue;
            for (let dy = 0; dy < sy; dy++) for (let dx = 0; dx < sx; dx++) paper.set(x0 + gx * sx + dx, top + gy * sy + dy);
          }
        }
      },
    });
  }

  #add(item: Item): void {
    if (this.#line.length && this.#x + item.width > this.modes.areaWidth) this.#printLine(this.modes.lineSpacing);
    item.x = this.#x;
    this.#x += item.width;
    this.#line.push(item);
  }

  /** Print the line buffer and advance the paper by at least `feed` dots. */
  #printLine(feed: number): void {
    const paper = this.hooks.paper();
    const height = Math.max(0, ...this.#line.map((i) => i.height));
    const top = paper.height;
    paper.ensure(top + Math.max(height, feed));
    const right = Math.max(0, ...this.#line.map((i) => i.x + i.width));
    const offset = this.#alignOffset(right);
    for (const item of this.#line) item.draw(paper, offset + item.x, top + height);
    this.#line = [];
    this.#x = 0;
  }

  #alignOffset(contentWidth: number): number {
    const { align, leftMargin, areaWidth } = this.modes;
    const free = Math.max(0, areaWidth - contentWidth);
    return leftMargin + (align === 1 ? Math.floor(free / 2) : align === 2 ? free : 0);
  }

  /** A full-width block (raster, barcode, QR) printed on its own at the start of a line. */
  #block(width: number, height: number, draw: (paper: Bitmap, x: number, top: number) => void): void {
    if (this.#line.length) this.#printLine(this.modes.lineSpacing);
    const paper = this.hooks.paper();
    const top = paper.height;
    paper.ensure(top + height);
    draw(paper, this.#alignOffset(width), top);
  }

  // ---- graphics ----

  /** ESC * m nL nH d1..dk: column image placed in the line buffer (24 dots tall at 203 dpi). */
  #bitImage(b: Uint8Array): void {
    const mode = b[2];
    const columns = b[3] | (b[4] << 8);
    const tall = mode >= 32; // 24-dot modes
    const bytesPerColumn = tall ? 3 : 1;
    const sx = mode === 0 || mode === 32 ? 2 : 1; // single density: half horizontal resolution
    const sy = tall ? 1 : 3; // 8-dot modes: each dot is 3 dots tall at 203 dpi
    const data = b.subarray(5);
    this.#add({
      x: 0,
      width: columns * sx,
      height: 24,
      draw: (paper, x0, bottom) => {
        const top = bottom - 24;
        for (let c = 0; c < columns; c++)
          for (let k = 0; k < bytesPerColumn * 8; k++)
            if (data[c * bytesPerColumn + (k >> 3)] & (0x80 >> (k & 7)))
              for (let dy = 0; dy < sy; dy++) for (let dx = 0; dx < sx; dx++) paper.set(x0 + c * sx + dx, top + k * sy + dy);
      },
    });
  }

  /** GS v 0 m xL xH yL yH d1..dk */
  #raster(b: Uint8Array): void {
    const m = b[3] % 48;
    const sx = m & 1 ? 2 : 1;
    const sy = m & 2 ? 2 : 1;
    const bytesWide = b[4] | (b[5] << 8);
    const rows = b[6] | (b[7] << 8);
    const data = b.subarray(8);
    this.#block(bytesWide * 8 * sx, rows * sy, (paper, x0, top) => {
      for (let y = 0; y < rows; y++)
        for (let x = 0; x < bytesWide * 8; x++)
          if (data[y * bytesWide + (x >> 3)] & (0x80 >> (x & 7)))
            for (let dy = 0; dy < sy; dy++) for (let dx = 0; dx < sx; dx++) paper.set(x0 + x * sx + dx, top + y * sy + dy);
    });
  }

  /** GS k m ... — invalid data prints nothing, as on the printer. */
  #barcode(b: Uint8Array): void {
    const m = b[2];
    const type = barcodeType(m);
    const data = m <= 6 ? b.subarray(3, b.length - 1) : b.subarray(4, 4 + b[3]);
    const encoded = type && encodeBarcode(type, data);
    if (!encoded) return;
    const { height, module, hri, hriFont } = this.modes.barcode;
    const width = encoded.modules.length * module;
    if (width > this.modes.areaWidth) return;
    const font = printerFonts()[hriFont];
    const above = hri === 1 || hri === 3 ? font.height : 0;
    const below = hri === 2 || hri === 3 ? font.height : 0;
    this.#block(width, above + height + below, (paper, x0, top) => {
      encoded.modules.forEach((bar, i) => {
        if (!bar) return;
        for (let y = 0; y < height; y++) for (let dx = 0; dx < module; dx++) paper.set(x0 + i * module + dx, top + above + y);
      });
      const textX = x0 + Math.floor((width - encoded.hri.length * font.width) / 2);
      if (above) this.#drawText(paper, font, encoded.hri, textX, top);
      if (below) this.#drawText(paper, font, encoded.hri, textX, top + above + height);
    });
  }

  #drawText(paper: Bitmap, font: PrinterFont, text: string, x0: number, top: number): void {
    [...text].forEach((ch, i) => {
      const glyph = font.regular.glyph(ch.codePointAt(0)!) ?? font.regular.glyph(0x3f)!;
      for (let y = 0; y < font.height; y++)
        for (let x = 0; x < font.width; x++) if (glyph[y * font.width + x]) paper.set(x0 + i * font.width + x, top + y);
    });
  }

  /** GS ( k pL pH cn fn ... — QR Code (cn = 49) only. */
  #qr(b: Uint8Array): Support {
    const [cn, fn, p] = [b[5], b[6], b[7]];
    if (cn !== 49) return 'unsupported';
    const qr = this.modes.qr;
    switch (fn) {
      case 65: break; // model: only model 2 is rendered
      case 67: if (p >= 1 && p <= 16) qr.module = p; break;
      case 69: if (p >= 48 && p <= 51) qr.level = QR_LEVELS[p - 48]; break;
      case 80: qr.data = b.slice(8); break;
      case 81: this.#printQr(); break;
      default: return 'unsupported';
    }
    return 'supported';
  }

  #printQr(): void {
    const { data, level, module } = this.modes.qr;
    if (!data?.length) return;
    let symbol: ReturnType<typeof QRCode.create>;
    try {
      symbol = QRCode.create([{ data: Buffer.from(data), mode: 'byte' }], { errorCorrectionLevel: level });
    } catch {
      return; // data too long for a QR symbol: nothing is printed
    }
    const { size } = symbol.modules;
    const dots = size * module;
    if (dots > this.modes.areaWidth) return;
    this.#block(dots, dots, (paper, x0, top) => {
      for (let r = 0; r < size; r++)
        for (let c = 0; c < size; c++)
          if (symbol.modules.get(r, c))
            for (let dy = 0; dy < module; dy++) for (let dx = 0; dx < module; dx++) paper.set(x0 + c * module + dx, top + r * module + dy);
    });
  }

  // ---- paper ----

  #cut(feedUnits: number): void {
    if (this.#line.length) this.#printLine(this.modes.lineSpacing);
    if (feedUnits) this.hooks.paper().feed(Math.round(feedUnits * this.modes.unitY));
    this.hooks.cut();
  }
}
