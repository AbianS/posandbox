import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Printer } from './printer.ts';
import type { PrinterConfig, PrinterEvent, TicketInfo } from '../../shared/contract.ts';

const ESC = 0x1b, GS = 0x1d, DLE = 0x10, LF = 0x0a;
const bytes = (...parts: (number | string)[]) =>
  Uint8Array.from(parts.flatMap((p) => (typeof p === 'string' ? [...Buffer.from(p, 'latin1')] : [p])));
const SAMPLE = new Uint8Array(readFileSync(new URL('../../../fixtures/sample-ticket.bin', import.meta.url)));

const config: PrinterConfig = { id: 'front', name: 'Front', enabled: true, port: 9100, paperWidth: 80 };

function setup(cfg = config) {
  const saved: { info: TicketInfo; png: Buffer }[] = [];
  const events: PrinterEvent[] = [];
  const printer = new Printer(cfg, { saveTicket: (info, png) => saved.push({ info, png }) }, (e) => events.push(e));
  const sent: number[][] = [];
  printer.open('127.0.0.1:5000', (b) => sent.push([...b]));
  const hex = () => sent.map((s) => Buffer.from(s).toString('hex'));
  return { printer, saved, events, sent, hex };
}

test('answers a real-time status request on the same connection', () => {
  const { printer, hex } = setup();
  printer.receive(bytes(DLE, 4, 1));
  assert.deepEqual(hex(), ['12']);
});

test('paper out from the panel changes the binary status and blocks printing until paper is loaded', () => {
  const { printer, hex } = setup();
  printer.setFaults({ paperOut: true });
  printer.receive(bytes('Hola', LF, DLE, 4, 4));
  assert.deepEqual(hex(), ['7e'], 'real-time status still answered while offline');
  assert.equal(printer.paperHeight, 0, 'nothing printed while out of paper');
  assert.ok(printer.status().pendingBytes > 0);
  assert.equal(printer.status().online, false);

  printer.setFaults({ paperOut: false });
  assert.equal(printer.paperHeight, 30, 'pending data printed after recovery');
  assert.equal(printer.status().pendingBytes, 0);
});

test('GS r is an ordinary command: while the cover is open it waits in the buffer', () => {
  const { printer, hex } = setup();
  printer.setFaults({ coverOpen: true });
  printer.receive(bytes(GS, 'r', 1));
  assert.deepEqual(hex(), []);
  printer.setFaults({ coverOpen: false });
  assert.deepEqual(hex(), ['00']);
});

test('ASB sends the status when enabled and on every change of an enabled category', () => {
  const { printer, hex } = setup();
  printer.receive(bytes(GS, 'a', 0x0a)); // online/offline + paper
  assert.deepEqual(hex(), ['10000000']);
  printer.setFaults({ paperNearEnd: true });
  printer.setFaults({ coverOpen: true });
  printer.setFaults({ coverOpen: false });
  assert.deepEqual(hex(), ['10000000', '10000300', '38000300', '10000300']);
  printer.setFaults({ headOverheat: true }); // error category: not enabled, but it also goes offline
  assert.equal(hex().at(-1), '18400300');
});

test('ESC @ disables ASB but does not clear physical faults', () => {
  const { printer, hex } = setup();
  printer.receive(bytes(GS, 'a', 0xff, ESC, '@'));
  printer.setFaults({ paperNearEnd: true });
  assert.deepEqual(hex(), ['10000000']);
  printer.receive(bytes(DLE, 4, 4));
  assert.equal(hex().at(-1), '1e');
});

test('identifies itself as a TM-T20III', () => {
  const { printer, sent } = setup();
  printer.receive(bytes(GS, 'I', 67));
  assert.equal(Buffer.from(sent[0]).toString('latin1'), '_TM-T20III\0');
});

test('several tickets on one persistent connection: each cut archives one ticket', () => {
  const { printer, saved, events } = setup();
  printer.receive(bytes('uno', LF, GS, 'V', 1, 'dos', LF, GS, 'V', 1));
  assert.equal(saved.length, 2);
  assert.deepEqual(saved.map((s) => s.info.end), ['cut', 'cut']);
  assert.equal(saved[0].info.heightDots, 30);
  assert.ok(saved[0].png.subarray(1, 4).toString() === 'PNG');
  assert.equal(events.filter((e) => e.type === 'printer.ticket').length, 2);
  assert.equal(printer.paperHeight, 0);
});

test('a cut without anything printed does not create a ticket', () => {
  const { printer, saved } = setup();
  printer.receive(bytes(GS, 'V', 1));
  assert.equal(saved.length, 0);
});

test('the same stream whole or fragmented gives the same tickets and responses', () => {
  // Real-time answers go out on arrival, queued ones on execution, so only the order may differ.
  const run = (chunks: Uint8Array[]) => {
    const s = setup();
    for (const c of chunks) s.printer.receive(c);
    return { pngs: s.saved.map((t) => createHash('sha1').update(t.png).digest('hex')), sent: s.hex().join('').match(/../g)!.sort() };
  };
  const stream = bytes(DLE, 4, 1, ...SAMPLE, GS, 'r', 1, ...SAMPLE, DLE, 4, 4);
  const whole = run([stream]);
  let seed = 7;
  const random = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % 97) + 1;
  const pieces: Uint8Array[] = [];
  for (let i = 0; i < stream.length; ) {
    const n = random();
    pieces.push(stream.subarray(i, i + n));
    i += n;
  }
  assert.equal(whole.pngs.length, 2);
  assert.deepEqual(run(pieces), whole);
  assert.deepEqual(run([...stream].map((b) => Uint8Array.of(b))), whole);
});

test('closing the connection mid-command discards only the incomplete command and invents no cut', () => {
  const { printer, saved, events } = setup();
  printer.receive(bytes('Hola', LF, GS, 'v', '0', 0, 10, 0, 10, 0, 1, 2, 3));
  printer.close('client closed');
  assert.equal(printer.paperHeight, 30, 'the complete line stays on the paper');
  assert.equal(saved.length, 0, 'no ticket invented');
  assert.equal(printer.status().pendingBytes, 0);
  assert.equal(printer.status().client, null);
  const log = events.flatMap((e) => (e.type === 'printer.inspector' ? e.entries : []));
  assert.ok(log.some((l) => l.kind === 'info' && /incomplet/i.test(l.label)), 'diagnostic entry');
});

test('complete commands received while offline survive a disconnection and print on recovery', () => {
  const { printer } = setup();
  printer.setFaults({ paperOut: true });
  printer.receive(bytes('Hola', LF));
  printer.close('client closed');
  printer.setFaults({ paperOut: false });
  assert.equal(printer.paperHeight, 30);
});

test('the receive buffer fills up while offline (TCP backpressure) and drains when back online', () => {
  const { printer } = setup();
  printer.setFaults({ coverOpen: true });
  assert.equal(printer.accepting, true);
  printer.receive(new Uint8Array(70_000).fill(0x41));
  assert.equal(printer.accepting, false);
  printer.setFaults({ coverOpen: false });
  assert.equal(printer.accepting, true);
});

test('DLE DC4 fn=8 clears the buffers and acknowledges', () => {
  const { printer, hex } = setup();
  printer.setFaults({ paperOut: true });
  printer.receive(bytes('lost', LF, DLE, 0x14, 8, 1, 3, 20, 1, 6, 2, 8, 'kept', LF));
  assert.deepEqual(hex(), ['372500']);
  printer.setFaults({ paperOut: false });
  assert.equal(printer.paperHeight, 30, 'only the data after the clear is printed');
});

test('tearing the paper off archives a partial ticket', () => {
  const { printer, saved } = setup();
  printer.receive(bytes('Hola', LF));
  printer.tearOff();
  assert.equal(saved[0].info.end, 'torn');
  assert.equal(printer.paperHeight, 0);
});

test('ESC p on pin 2 opens the drawer: DLE EOT 1, GS r 2 and ASB report pin 3 high until closed by hand', () => {
  const { printer, hex } = setup();
  printer.receive(bytes(GS, 'a', 0x01)); // ASB: drawer
  printer.receive(bytes(ESC, 'p', 1, 25, 250)); // pin 5: no drawer there
  assert.equal(printer.status().drawerOpen, false);
  printer.receive(bytes(ESC, 'p', 0, 25, 250));
  assert.equal(printer.status().drawerOpen, true);
  printer.receive(bytes(DLE, 4, 1, GS, 'r', 2));
  printer.setDrawer(false);
  assert.equal(printer.status().drawerOpen, false);
  assert.deepEqual(hex(), ['10000000', '14000000', '16', '01', '10000000']);
});

test('the real-time pulse DLE DC4 1 opens the drawer even while offline', () => {
  const { printer } = setup();
  printer.setFaults({ coverOpen: true });
  printer.receive(bytes(DLE, 0x14, 1, 0, 1));
  assert.equal(printer.status().drawerOpen, true);
});

test('the inspector records received and sent bytes, commands and unknown codes', () => {
  const { printer } = setup();
  printer.receive(bytes(ESC, 0x01, DLE, 4, 1));
  const kinds = printer.snapshot().inspector.map((e) => `${e.kind}:${e.support ?? ''}`);
  assert.ok(kinds.includes('rx:'));
  assert.ok(kinds.includes('tx:'));
  assert.ok(kinds.includes('command:unknown'));
});

test('58 mm paper prints 420 dots wide', () => {
  const { printer, saved } = setup({ ...config, paperWidth: 58 });
  printer.receive(bytes('x', LF, GS, 'V', 1));
  assert.equal(saved[0].info.widthDots, 420);
});

test('the self-test prints the sample ticket through the normal pipeline', () => {
  const { printer, saved } = setup();
  assert.equal(printer.selfTest(SAMPLE), true);
  assert.equal(saved.length, 1);
});

test('GS ( D can disable the real-time drawer pulse; ESC @ re-enables it', () => {
  const log = (s: ReturnType<typeof setup>) =>
    s.events.flatMap((e) => (e.type === 'printer.inspector' ? e.entries : [])).filter((l) => l.label.startsWith('Drawer pulse') && l.label.includes('real time')).length;
  const s = setup();
  s.printer.receive(bytes(GS, '(', 'D', 3, 0, 20, 1, 0)); // a=1 (pulse) b=0 (disabled)
  s.printer.receive(bytes(DLE, 0x14, 1, 0, 1));
  assert.equal(log(s), 0);
  s.printer.receive(bytes(ESC, '@'));
  s.printer.receive(bytes(DLE, 0x14, 1, 0, 1));
  assert.equal(log(s), 1);
});
