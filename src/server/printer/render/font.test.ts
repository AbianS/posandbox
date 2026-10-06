import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBdf } from './font.ts';

// 4x4 cell, ascent 3, descent 1. 'A' is a 2x2 block sitting on the baseline at x=1.
const BDF = `STARTFONT 2.1
FONTBOUNDINGBOX 4 4 0 -1
STARTPROPERTIES 2
FONT_ASCENT 3
FONT_DESCENT 1
ENDPROPERTIES
CHARS 2
STARTCHAR A
ENCODING 65
BBX 2 2 1 0
BITMAP
C0
C0
ENDCHAR
STARTCHAR g
ENCODING 103
BBX 1 2 0 -1
BITMAP
80
80
ENDCHAR
ENDFONT
`;

const cell = (font: ReturnType<typeof parseBdf>, cp: number) => {
  const g = font.glyph(cp)!;
  const rows: string[] = [];
  for (let y = 0; y < font.height; y++) {
    let r = '';
    for (let x = 0; x < font.width; x++) r += g[y * font.width + x] ? '#' : '.';
    rows.push(r);
  }
  return rows.join('\n');
};

test('parses the cell size from the bounding box', () => {
  const font = parseBdf(BDF);
  assert.equal(font.width, 4);
  assert.equal(font.height, 4);
});

test('places glyphs on the baseline using their BBX offsets', () => {
  const font = parseBdf(BDF);
  assert.equal(cell(font, 65), '....\n.##.\n.##.\n....');
  assert.equal(cell(font, 103), '....\n....\n#...\n#...');
});

test('returns undefined for missing glyphs', () => {
  assert.equal(parseBdf(BDF).glyph(0x20ac), undefined);
});
