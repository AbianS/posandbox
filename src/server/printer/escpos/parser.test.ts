import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Parser, type Token } from './parser.ts';

const bytes = (...parts: (number | string)[]) =>
  Uint8Array.from(parts.flatMap((p) => (typeof p === 'string' ? [...Buffer.from(p, 'latin1')] : [p])));
const ESC = 0x1b, GS = 0x1d, FS = 0x1c, DLE = 0x10, LF = 0x0a;

const describe = (t: Token) => (t.kind === 'text' ? `text:${Buffer.from(t.bytes).toString('latin1')}` : `${t.kind}:${t.name}`);

function parseAll(chunks: Uint8Array[]): Token[] {
  const parser = new Parser();
  const out: Token[] = [];
  for (const c of chunks) {
    parser.push(c);
    for (let t = parser.next(); t; t = parser.next()) out.push(t);
  }
  return out;
}

test('splits text and commands', () => {
  const tokens = parseAll([bytes(ESC, '@', 'Hola', LF, ESC, 'E', 1, 'X', GS, 'V', 0)]);
  assert.deepEqual(tokens.map(describe), ['command:ESC @', 'text:Hola', 'command:LF', 'command:ESC E', 'text:X', 'command:GS V']);
  const emph = tokens[3];
  assert.ok(emph.kind === 'command');
  assert.deepEqual([...emph.bytes], [ESC, 0x45, 1]);
});

test('waits for incomplete commands and resumes across chunks', () => {
  const tokens = parseAll([bytes(ESC), bytes('E'), bytes(1, 'A', GS, '!'), bytes(0x11)]);
  assert.deepEqual(tokens.map(describe), ['command:ESC E', 'text:A', 'command:GS !']);
});

test('a whole stream and the same stream split byte by byte produce the same tokens', () => {
  const ticket = new Uint8Array(readFileSync(new URL('../../../../fixtures/sample-ticket.bin', import.meta.url)));
  const whole = parseAll([ticket]).map(describe);
  const split = parseAll([...ticket].map((b) => Uint8Array.of(b))).map(describe);
  // Text runs may be split differently; compare the concatenated text and the command sequence.
  const norm = (ts: string[]) => ts.join('\u0000').replace(/\u0000text:/g, '');
  assert.equal(norm(split), norm(whole));
  assert.ok(!whole.some((t) => t.startsWith('unknown')), `unknown tokens: ${whole.filter((t) => t.startsWith('unknown'))}`);
});

test('consumes graphics data by its declared length, even if it looks like commands', () => {
  // GS v 0: m=0, xL=1, xH=0 (1 byte per row), yL=3, yH=0 -> 3 data bytes that look like ESC @ LF
  const tokens = parseAll([bytes(GS, 'v', '0', 0, 1, 0, 3, 0, ESC, '@', LF, 'Z')]);
  assert.deepEqual(tokens.map(describe), ['command:GS v 0', 'text:Z']);
});

test('length-prefixed commands: GS ( k, ESC *, GS k in both forms, NUL-terminated ESC D', () => {
  const tokens = parseAll([
    bytes(GS, '(', 'k', 3, 0, '1', 'C', 6),
    bytes(ESC, '*', 33, 2, 0, 1, 2, 3, 4, 5, 6),
    bytes(GS, 'k', 4, '*AB*', 0),
    bytes(GS, 'k', 73, 4, '{B12'),
    bytes(ESC, 'D', 8, 16, 0),
    bytes('ok'),
  ]);
  assert.deepEqual(tokens.map(describe), ['command:GS ( k', 'command:ESC *', 'command:GS k', 'command:GS k', 'command:ESC D', 'text:ok']);
});

test('real-time commands are tokens too', () => {
  const tokens = parseAll([bytes(DLE, 4, 1, DLE, 0x14, 1, 0, 1, DLE, 0x14, 8, 1, 3, 20, 1, 6, 2, 8, 'x')]);
  assert.deepEqual(tokens.map(describe), ['command:DLE EOT', 'command:DLE DC4', 'command:DLE DC4', 'text:x']);
});

test('unknown commands are reported and only their prefix is consumed', () => {
  const tokens = parseAll([bytes(ESC, 0x01, 'A', FS, 0x7f, 'B')]);
  assert.deepEqual(tokens.map(describe), ['unknown:ESC 0x01', 'text:A', 'unknown:FS 0x7f', 'text:B']);
});

test('oversized declared lengths are skipped without buffering the data', () => {
  const parser = new Parser({ maxCommandBytes: 16 });
  parser.push(bytes(GS, 'v', '0', 0, 100, 0, 100, 0, ...new Array(30).fill(0)));
  const t = parser.next();
  assert.ok(t && t.kind === 'oversized');
  assert.equal(t.name, 'GS v 0');
  assert.equal(t.declared, 8 + 100 * 100);
  assert.equal(parser.next(), undefined);
  parser.push(new Uint8Array(100 * 100 - 30));
  parser.push(bytes('after'));
  assert.deepEqual(describe(parser.next()!), 'text:after');
});

test('pending reports the bytes received but not yet tokenised', () => {
  const parser = new Parser();
  parser.push(bytes('AB', ESC));
  assert.equal(parser.pending, 3);
  parser.next();
  assert.equal(parser.pending, 1);
  parser.clear();
  assert.equal(parser.pending, 0);
});
