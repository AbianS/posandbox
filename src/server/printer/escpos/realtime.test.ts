import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RealtimeScanner } from './realtime.ts';

const scan = (...chunks: number[][]) => {
  const s = new RealtimeScanner();
  return chunks.flatMap((c) => s.scan(Uint8Array.from(c))).map((c) => [c.name, ...c.bytes.slice(2)]);
};

test('finds status requests in the middle of other data', () => {
  assert.deepEqual(scan([0x41, 0x10, 0x04, 0x01, 0x42, 0x10, 0x04, 0x04]), [
    ['DLE EOT', 1],
    ['DLE EOT', 4],
  ]);
});

test('finds them even inside graphics data, as the printer does (Epson: also processed as real-time)', () => {
  // GS v 0 with 3 data bytes 10 04 02
  assert.deepEqual(scan([0x1d, 0x76, 0x30, 0, 1, 0, 3, 0, 0x10, 0x04, 0x02]), [['DLE EOT', 2]]);
});

test('handles commands split across TCP reads', () => {
  assert.deepEqual(scan([0x10], [0x04], [0x03]), [['DLE EOT', 3]]);
  assert.deepEqual(scan([0x10, 0x14, 0x01, 0x00], [0x05]), [['DLE DC4', 1, 0, 5]]);
  assert.deepEqual(scan([0x10, 0x14, 0x08, 1, 3], [20, 1, 6, 2, 8]), [['DLE DC4', 8, 1, 3, 20, 1, 6, 2, 8]]);
});

test('ignores parameters the profile does not define', () => {
  // TM-T20III: DLE EOT n = 1..4 only; DLE ENQ n = 1, 2; DLE DC4 fn=1 needs t = 1..8
  assert.deepEqual(scan([0x10, 0x04, 0x07, 0x10, 0x05, 0x00, 0x10, 0x14, 0x01, 0x00, 0x09]), []);
});

test('reports where each command ends in the chunk that completed it', () => {
  const s = new RealtimeScanner();
  s.scan(Uint8Array.of(0x41, 0x10));
  assert.deepEqual(s.scan(Uint8Array.of(0x04, 0x01, 0x42)).map((c) => c.end), [2]);
});

test('recognises DLE ENQ', () => {
  assert.deepEqual(scan([0x10, 0x05, 0x02]), [['DLE ENQ', 2]]);
});

test('a DLE that turns out not to be a command does not hide the next one', () => {
  assert.deepEqual(scan([0x10, 0x10, 0x04, 0x01]), [['DLE EOT', 1]]);
});
