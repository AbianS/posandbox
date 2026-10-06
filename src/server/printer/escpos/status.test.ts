import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asb, dleEot, gsI, gsR, type StatusState } from './status.ts';

const idle: StatusState = {
  faults: { paperNearEnd: false, paperOut: false, coverOpen: false, headOverheat: false },
  drawerPin3: false,
  feeding: false,
};
const withFault = (f: keyof StatusState['faults']): StatusState => ({ ...idle, faults: { ...idle.faults, [f]: true } });
const hex = (b: Uint8Array | undefined) => (b ? Buffer.from(b).toString('hex') : 'none');

test('DLE EOT idle answers 0x12 for n = 1..4', () => {
  assert.deepEqual([1, 2, 3, 4].map((n) => hex(dleEot(n, idle))), ['12', '12', '12', '12']);
});

test('DLE EOT with paper out (Epson TM-T20III): offline, stopped by paper end, paper not present', () => {
  assert.deepEqual([1, 2, 3, 4].map((n) => hex(dleEot(n, withFault('paperOut')))), ['1a', '32', '12', '7e']);
});

test('DLE EOT with cover open: offline + cover open bit', () => {
  assert.deepEqual([1, 2].map((n) => hex(dleEot(n, withFault('coverOpen')))), ['1a', '16']);
});

test('DLE EOT with paper near end only sets the roll sensor bits and stays online', () => {
  assert.deepEqual([1, 4].map((n) => hex(dleEot(n, withFault('paperNearEnd')))), ['12', '1e']);
});

test('DLE EOT with an auto-recoverable error (head overheat)', () => {
  assert.deepEqual([1, 2, 3].map((n) => hex(dleEot(n, withFault('headOverheat')))), ['1a', '52', '52']);
});

test('DLE EOT reports drawer pin 3 and paper fed by the FEED button', () => {
  assert.equal(hex(dleEot(1, { ...idle, drawerPin3: true })), '16');
  assert.equal(hex(dleEot(2, { ...idle, feeding: true })), '1a');
});

test('GS r: paper sensor and drawer, without fixed bits', () => {
  assert.equal(hex(gsR(1, idle)), '00');
  assert.equal(hex(gsR(49, withFault('paperNearEnd'))), '03');
  assert.equal(hex(gsR(1, withFault('paperOut'))), '0f');
  assert.equal(hex(gsR(2, { ...idle, drawerPin3: true })), '01');
  assert.equal(hex(gsR(7, idle)), 'none');
});

test('ASB 4-byte status', () => {
  assert.equal(hex(asb(idle)), '10000000');
  assert.equal(hex(asb(withFault('paperOut'))), '18000f00');
  assert.equal(hex(asb(withFault('coverOpen'))), '38000000');
  assert.equal(hex(asb(withFault('paperNearEnd'))), '10000300');
  assert.equal(hex(asb(withFault('headOverheat'))), '18400000');
});

test('GS I identification for TM-T20III', () => {
  assert.equal(hex(gsI(1)), '63');
  assert.equal(hex(gsI(50)), '02');
  assert.equal(Buffer.from(gsI(66)!).toString('latin1'), '_EPSON\0');
  assert.equal(Buffer.from(gsI(67)!).toString('latin1'), '_TM-T20III\0');
  assert.equal(hex(gsI(69)), '5f00');
  assert.equal(hex(gsI(3)), 'none');
});
