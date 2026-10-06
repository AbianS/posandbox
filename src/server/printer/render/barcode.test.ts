import { test } from 'node:test';
import assert from 'node:assert/strict';
import bwipjs from 'bwip-js';
import { barcodeType, encodeBarcode, type BarcodeType } from './barcode.ts';

const bytes = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const encode = (type: BarcodeType, data: string | number[]) =>
  encodeBarcode(type, typeof data === 'string' ? bytes(data) : Uint8Array.from(data));

// bwip-js renders wide elements as 3 (or 2) modules; `wide` normalizes them to our ratio.
function oracle(bcid: string, text: string, opts: Record<string, unknown> = {}, wide?: number): number[] {
  const [{ sbs }] = bwipjs.raw({ bcid, text, ...opts }) as unknown as [{ sbs: number[] }];
  if (sbs.length % 2 === 0) sbs.pop(); // drop a trailing space (inter-character gap after the stop char)
  return sbs.flatMap((w, i) => Array(wide && w > 1 ? wide : w).fill(i % 2 === 0 ? 1 : 0));
}

function assertModules(type: BarcodeType, data: string | number[], expected: number[]) {
  const result = encode(type, data);
  assert.ok(result, `${type} ${data} should encode`);
  assert.deepEqual([...result.modules], expected);
}

test('barcodeType maps both GS k forms', () => {
  const types: BarcodeType[] = ['UPC-A', 'UPC-E', 'EAN13', 'EAN8', 'CODE39', 'ITF', 'CODABAR'];
  types.forEach((t, i) => {
    assert.equal(barcodeType(i), t);
    assert.equal(barcodeType(65 + i), t);
  });
  assert.equal(barcodeType(72), 'CODE93');
  assert.equal(barcodeType(73), 'CODE128');
  assert.equal(barcodeType(7), undefined);
  assert.equal(barcodeType(74), undefined);
});

test('EAN13 computes the check digit from 12 digits', () => {
  assert.equal(encode('EAN13', '400638133393')?.hri, '4006381333931');
  assertModules('EAN13', '400638133393', oracle('ean13', '4006381333931'));
});

test('EAN13 uses a 13th digit as-is without validating it', () => {
  assert.equal(encode('EAN13', '4006381333930')?.hri, '4006381333930');
});

test('EAN8 computes the check digit from 7 digits', () => {
  assert.equal(encode('EAN8', '9638507')?.hri, '96385074');
  assertModules('EAN8', '9638507', oracle('ean8', '96385074'));
});

test('UPC-A computes the check digit from 11 digits', () => {
  assert.equal(encode('UPC-A', '03600029145')?.hri, '036000291452');
  assertModules('UPC-A', '03600029145', oracle('upca', '036000291452'));
  assertModules('UPC-A', '036000291452', oracle('upca', '036000291452'));
});

test('UPC-E accepts 6, 7, 8, 11 and 12 digit forms', () => {
  const expected = oracle('upce', '0123456');
  for (const data of ['123456', '0123456', '01234565', '01234500006', '012345000065']) {
    assertModules('UPC-E', data, expected);
    assert.equal(encode('UPC-E', data)?.hri, '123456');
  }
  assertModules('UPC-E', '0654321', oracle('upce', '0654321'));
});

test('UPC-E rejects non-zero number system and non-compressible UPC-A', () => {
  assert.equal(encode('UPC-E', '1123456'), undefined);
  assert.equal(encode('UPC-E', '01234567890'), undefined);
});

test('EAN/UPC reject wrong lengths and non-digits', () => {
  assert.equal(encode('EAN13', '40063813339A'), undefined);
  assert.equal(encode('EAN13', '40063813339'), undefined);
  assert.equal(encode('EAN8', '963850'), undefined);
  assert.equal(encode('UPC-A', '0360002914'), undefined);
});

test('CODE39 adds * delimiters and prints them in HRI', () => {
  assertModules('CODE39', 'AB-12 $', oracle('code39', 'AB-12 $', {}, 2));
  assert.equal(encode('CODE39', 'AB')?.hri, '*AB*');
  assert.deepEqual(encode('CODE39', '*AB*'), encode('CODE39', 'AB'));
  assert.deepEqual(encode('CODE39', 'AB*CD'), encode('CODE39', 'AB'));
  assert.equal(encode('CODE39', 'ab'), undefined);
});

test('ITF encodes digit pairs and ignores a trailing odd digit', () => {
  assertModules('ITF', '1234567890', oracle('interleaved2of5', '1234567890', {}, 2));
  assert.equal(encode('ITF', '1234')?.hri, '1234');
  assert.deepEqual(encode('ITF', '123'), encode('ITF', '12'));
  assert.equal(encode('ITF', '1'), undefined);
  assert.equal(encode('ITF', '12A4'), undefined);
});

test('CODABAR requires start/stop characters at both ends', () => {
  assertModules('CODABAR', 'A40156$-:/.+B', oracle('rationalizedCodabar', 'A40156$-:/.+B', {}, 2));
  assert.deepEqual(encode('CODABAR', 'a12d')?.modules, encode('CODABAR', 'A12D')?.modules);
  assert.equal(encode('CODABAR', 'A1234B')?.hri, 'A1234B');
  assert.equal(encode('CODABAR', '1234B'), undefined);
  assert.equal(encode('CODABAR', 'A12B34C'), undefined);
});

test('CODE93 adds two check characters', () => {
  assertModules('CODE93', 'TEST93', oracle('code93', 'TEST93', { includecheck: true }));
  assertModules('CODE93', 'a\x01Z', oracle('code93ext', 'a\x01Z', { includecheck: true }));
});

test('CODE93 HRI marks start/stop and control characters', () => {
  assert.equal(encode('CODE93', 'a\x01Z')?.hri, '□a■AZ□');
  assert.equal(encode('CODE93', [0x80]), undefined);
});

test('CODE128 encodes code set B followed by code set C', () => {
  const data = [...bytes('{BAb{C'), 12, 34];
  assertModules('CODE128', data, oracle('code128', '^104^033^066^099^012^034', { raw: true }));
  assert.equal(encode('CODE128', data)?.hri, 'Ab1234');
});

test('CODE128 handles code A, shift, FNC1 and literal {', () => {
  const data = [...bytes('{AA'), 0x01, ...bytes('{Sa{1{B{{')];
  assertModules('CODE128', data, oracle('code128', '^103^033^065^098^065^102^100^091', { raw: true }));
  assert.equal(encode('CODE128', data)?.hri, 'A a {');
});

test('CODE128 rejects invalid data', () => {
  assert.equal(encode('CODE128', 'AB'), undefined);
  assert.equal(encode('CODE128', [...bytes('{C'), 100]), undefined);
  assert.equal(encode('CODE128', '{Aa'), undefined);
  assert.equal(encode('CODE128', '{B{X'), undefined);
});
