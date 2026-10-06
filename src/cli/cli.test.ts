import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLab, type RunningLab } from '../server/main.ts';
import { run } from './main.ts';
import { decodeStatus, encodeText } from './printer.ts';

async function withLab(fn: (lab: RunningLab, args: string[]) => Promise<void>) {
  const dataDir = mkdtempSync(join(tmpdir(), 'posandbox-cli-'));
  mkdirSync(join(dataDir, 'dist'));
  const lab = await startLab({ dataDir, staticDir: join(dataDir, 'dist'), host: '127.0.0.1', httpPort: 0, printerPort: 0, terminalPort: 0 });
  try {
    await fn(lab, ['--port', String(lab.printerPort('front')), '--lab', `http://127.0.0.1:${lab.httpPort}`]);
  } finally {
    await lab.stop();
  }
}

async function cli(...argv: string[]) {
  const lines: string[] = [];
  const code = await run(argv, (line) => lines.push(line));
  return { code, out: lines.join('\n') };
}

test('decodes the DLE EOT bytes into what they mean', () => {
  assert.deepEqual(decodeStatus(1, 0x12), []);
  assert.deepEqual(decodeStatus(1, 0x1a), ['offline']);
  assert.deepEqual(decodeStatus(2, 0x16), ['cover open']);
  assert.deepEqual(decodeStatus(2, 0x32), ['stopped: paper out']);
  assert.deepEqual(decodeStatus(3, 0x52), ['automatically recoverable error']);
  assert.deepEqual(decodeStatus(4, 0x7e), ['paper near end', 'paper out']);
});

test('encodes text in PC858 so € and Spanish characters survive', () => {
  assert.deepEqual([...encodeText('€ñ¿')], [0xd5, 0xa4, 0xa8]);
  assert.deepEqual([...encodeText('A?')], [0x41, 0x3f]);
});

test('printer status talks to the device over TCP', () =>
  withLab(async (_lab, args) => {
    const { code, out } = await cli('printer', 'status', ...args);
    assert.equal(code, 0);
    assert.match(out, /EPSON TM-T20III/);
    assert.match(out, /online/i);
  }));

test('a fault set with the lab command is what printer status reads', () =>
  withLab(async (_lab, args) => {
    assert.equal((await cli('lab', 'fault', 'paperOut', 'on', ...args)).code, 0);
    const { out } = await cli('printer', 'status', ...args);
    assert.match(out, /paper out/);
    assert.equal((await cli('lab', 'fault', 'paperOut', 'off', ...args)).code, 0);
  }));

test('printer drawer opens the drawer; lab drawer close closes it', () =>
  withLab(async (_lab, args) => {
    assert.equal((await cli('printer', 'drawer', ...args)).code, 0);
    assert.match((await cli('printer', 'status', ...args)).out, /drawer open/);
    assert.equal((await cli('lab', 'drawer', 'close', ...args)).code, 0);
    assert.doesNotMatch((await cli('printer', 'status', ...args)).out, /drawer open/);
  }));

test('printer text prints and cuts a ticket; sample sends the representative ticket', () =>
  withLab(async (lab, args) => {
    assert.equal((await cli('printer', 'text', 'Hola € mundo', 'segunda línea', '--cut', ...args)).code, 0);
    assert.equal((await cli('printer', 'sample', ...args)).code, 0);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(lab.lab.snapshot().printers[0].tickets.length, 2);
  }));

test('printer hex sends raw bytes and shows the reply', () =>
  withLab(async (_lab, args) => {
    const { out } = await cli('printer', 'hex', '10 04 01', ...args);
    assert.match(out, /← 12/);
  }));

test('printer send streams a file', () =>
  withLab(async (lab, args) => {
    const file = join(mkdtempSync(join(tmpdir(), 'posandbox-bin-')), 't.bin');
    writeFileSync(file, Buffer.from('Fichero\n\x1dV\x01', 'latin1'));
    assert.equal((await cli('printer', 'send', file, ...args)).code, 0);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(lab.lab.snapshot().printers[0].tickets.length, 1);
  }));

test('reports a clear error when the device is not reachable', async () => {
  const { code, out } = await cli('printer', 'status', '--port', '1', '--timeout', '500');
  assert.equal(code, 1);
  assert.match(out, /Cannot connect/);
});

test('shows help for unknown commands', async () => {
  const { code, out } = await cli('nope');
  assert.equal(code, 2);
  assert.match(out, /posandbox printer status/);
});

test('terminal pay acts as a POS over HTTPS; the lab plays the shopper', () =>
  withLab(async (lab, args) => {
    const terminalArgs = [...args, '--terminal-port', String(lab.terminalPort('counter'))];
    assert.equal((await cli('lab', 'terminal', 'shopper', 'auto', ...terminalArgs)).code, 0);
    const paid = await cli('terminal', 'pay', '12,50', ...terminalArgs);
    assert.equal(paid.code, 0, paid.out);
    assert.match(paid.out, /Result: Success/);
    assert.match(paid.out, /visa 411111 \*\*\*\* 0002 · Contactless/);
    assert.match((await cli('terminal', 'ping', ...terminalArgs)).out, /V400m-324688179: OK/);
  }));
