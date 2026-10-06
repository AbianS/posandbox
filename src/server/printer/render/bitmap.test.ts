import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { Bitmap } from './bitmap.ts';

test('starts empty and grows when drawing below the current height', () => {
  const bmp = new Bitmap(16);
  assert.equal(bmp.height, 0);
  bmp.set(3, 10);
  assert.equal(bmp.height, 11);
  assert.equal(bmp.get(3, 10), true);
  assert.equal(bmp.get(4, 10), false);
});

test('ignores dots outside the printable width', () => {
  const bmp = new Bitmap(8);
  bmp.set(8, 0);
  bmp.set(-1, 0);
  assert.equal(bmp.get(8, 0), false);
  assert.equal(bmp.height, 0);
});

test('feed adds blank rows', () => {
  const bmp = new Bitmap(8);
  bmp.feed(5);
  assert.equal(bmp.height, 5);
  assert.equal(bmp.get(0, 4), false);
});

test('respects the maximum height and reports truncation', () => {
  const bmp = new Bitmap(8, 4);
  bmp.feed(10);
  assert.equal(bmp.height, 4);
  assert.equal(bmp.truncated, true);
});

test('encodes a 1-bit PNG where printed dots are black', () => {
  const bmp = new Bitmap(10);
  bmp.set(0, 0);
  bmp.set(9, 1);
  const png = bmp.toPng();
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.readUInt32BE(16), 10); // IHDR width
  assert.equal(png.readUInt32BE(20), 2); // IHDR height
  assert.equal(png[24], 1); // bit depth
  const idatLen = png.readUInt32BE(33);
  const raw = inflateSync(png.subarray(41, 41 + idatLen));
  // each row: filter byte + 2 bytes; PNG gray 0 = black
  assert.deepEqual([...raw], [0, 0b01111111, 0b11111111, 0, 0b11111111, 0b10111111]);
});

test('an empty bitmap still encodes as a valid 1-row image', () => {
  const png = new Bitmap(8).toPng();
  assert.equal(png.readUInt32BE(20), 1);
});
