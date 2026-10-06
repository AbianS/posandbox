/** A fixed-cell bitmap font: each glyph is a width*height array of dots (1 = ink). */
export interface BitmapFont {
  width: number;
  height: number;
  glyph(codePoint: number): Uint8Array | undefined;
}

/** Minimal BDF reader for monospace fonts: enough for the fonts bundled in /fonts. */
export function parseBdf(source: string): BitmapFont {
  const lines = source.split(/\r?\n/);
  const nums = (line: string) => line.trim().split(/\s+/).slice(1).map(Number);
  let width = 0;
  let height = 0;
  let ascent = 0;
  const glyphs = new Map<number, Uint8Array>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('FONTBOUNDINGBOX')) [width, height] = nums(line);
    else if (line.startsWith('FONT_ASCENT')) [ascent] = nums(line);
    else if (line.startsWith('STARTCHAR')) {
      let code = -1;
      let bbx = [0, 0, 0, 0];
      while (!lines[++i].startsWith('BITMAP')) {
        if (lines[i].startsWith('ENCODING')) [code] = nums(lines[i]);
        else if (lines[i].startsWith('BBX')) bbx = nums(lines[i]);
      }
      const [w, h, xoff, yoff] = bbx;
      const dots = new Uint8Array(width * height);
      const top = ascent - yoff - h; // first glyph row, counted from the cell top
      for (let row = 0; row < h; row++) {
        const bits = BigInt('0x' + lines[++i].trim());
        const rowBits = lines[i].trim().length * 4;
        const y = top + row;
        for (let col = 0; col < w; col++) {
          const x = xoff + col;
          const on = (bits >> BigInt(rowBits - 1 - col)) & 1n;
          if (on && x >= 0 && x < width && y >= 0 && y < height) dots[y * width + x] = 1;
        }
      }
      if (code >= 0) glyphs.set(code, dots);
    }
  }
  return { width, height, glyph: (cp) => glyphs.get(cp) };
}
