import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paperPath, surfaceHeight, SLOT } from './paper-path.ts';

const round = (v: number) => Math.round(v * 1e6) / 1e6;
const points = (path: Float32Array) => Array.from({ length: path.length / 2 }, (_, i) => ({ z: round(path[i * 2]), y: round(path[i * 2 + 1]) }));

test('starts at the slot and leaves it straight up', () => {
  const p = points(paperPath(0.008, 8));
  assert.deepEqual(p[0], { z: SLOT.z, y: SLOT.y });
  for (const { z, y } of p) assert.ok(Math.abs(z - SLOT.z) < 1e-6 && y >= SLOT.y);
  assert.ok(Math.abs(p.at(-1)!.y - (SLOT.y + 0.008)) < 1e-4);
});

test('never stretches the paper: consecutive points are at most length/segments apart, and not much less', () => {
  const p = points(paperPath(0.3, 60));
  for (let i = 1; i < p.length; i++) {
    const d = Math.hypot(p[i].z - p[i - 1].z, p[i].y - p[i - 1].y);
    assert.ok(d <= 0.3 / 60 + 1e-5 && d > 0.7 * (0.3 / 60), `segment ${i}: ${d}`);
  }
});

test('a longer strip curls back over the lid and never goes through the printer or the counter', () => {
  for (const length of [0.05, 0.12, 0.25, 0.5, 1.2]) {
    for (const { z, y } of points(paperPath(length, 200))) assert.ok(y >= surfaceHeight(z) - 1e-6, `L=${length} z=${z} y=${y}`);
  }
  const tip = points(paperPath(0.25, 100)).at(-1)!;
  assert.ok(tip.z < SLOT.z - 0.05, 'tip went backwards over the lid');
});

test('a very long ticket ends lying on the counter behind the printer', () => {
  const tip = points(paperPath(1.2, 300)).at(-1)!;
  assert.ok(tip.y < 0.002, `tip y ${tip.y}`);
  assert.ok(tip.z < -0.1);
});

test('zero length is a single point at the slot', () => {
  for (const { z, y } of points(paperPath(0, 4))) assert.deepEqual({ z, y }, { z: SLOT.z, y: SLOT.y });
});
