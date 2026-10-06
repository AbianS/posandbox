import { readFileSync } from 'node:fs';
import { parseBdf, type BitmapFont } from './font.ts';

// Substitution declared in docs: Epson's ROM glyphs are not public, so Terminus (SIL OFL 1.1) is used
// with the exact TM-T20III cell sizes. Font A = 12x24 (Terminus 12x24); Font B = 9x17 (Terminus 8x16 in a 9x17 cell).
export interface PrinterFont {
  width: number;
  height: number;
  regular: BitmapFont;
  bold: BitmapFont;
}

const load = (file: string) => parseBdf(readFileSync(new URL(`../../../../fonts/${file}`, import.meta.url), 'latin1'));

function inCell(font: BitmapFont, width: number, height: number): BitmapFont {
  const cells = new Map<number, Uint8Array | undefined>();
  return {
    width,
    height,
    glyph(cp) {
      if (!cells.has(cp)) {
        const src = font.glyph(cp);
        const dots = src && new Uint8Array(width * height);
        for (let y = 0; dots && y < font.height; y++) dots.set(src.subarray(y * font.width, (y + 1) * font.width), y * width);
        cells.set(cp, dots);
      }
      return cells.get(cp);
    },
  };
}

let cache: { A: PrinterFont; B: PrinterFont } | undefined;

export function printerFonts(): { A: PrinterFont; B: PrinterFont } {
  cache ??= {
    A: { width: 12, height: 24, regular: load('ter-u24n.bdf'), bold: load('ter-u24b.bdf') },
    B: { width: 9, height: 17, regular: inCell(load('ter-u16n.bdf'), 9, 17), bold: inCell(load('ter-u16b.bdf'), 9, 17) },
  };
  return cache;
}
