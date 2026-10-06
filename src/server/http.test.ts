import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';
import { once } from 'node:events';
import WebSocket from 'ws';
import { startLab, type RunningLab } from './main.ts';
import type { LabSnapshot, ServerMessage } from '../shared/contract.ts';

const ESC = 0x1b, GS = 0x1d, DLE = 0x10, LF = 0x0a;

async function withLab(fn: (lab: RunningLab, base: string) => Promise<void>) {
  const dataDir = mkdtempSync(join(tmpdir(), 'posandbox-http-'));
  const staticDir = join(dataDir, 'dist');
  mkdirSync(staticDir);
  writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>panel</title>');
  const lab = await startLab({ dataDir, staticDir, host: '127.0.0.1', httpPort: 0, printerPort: 0, terminalPort: 0 });
  try {
    await fn(lab, `http://127.0.0.1:${lab.httpPort}`);
  } finally {
    await lab.stop();
  }
}

const json = (body: unknown) => ({ method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function pos(port: number) {
  const socket = connect(port, '127.0.0.1');
  await once(socket, 'connect');
  const received: number[] = [];
  socket.on('data', (d) => received.push(...d));
  const send = async (...bytes: (number | string)[]) => {
    socket.write(Uint8Array.from(bytes.flatMap((b) => (typeof b === 'string' ? [...Buffer.from(b, 'latin1')] : [b]))));
    await new Promise((r) => setTimeout(r, 30));
  };
  return { socket, received, send };
}

test('a POS prints over TCP and the ticket is listed and downloadable from the API', () =>
  withLab(async (lab, base) => {
    const { socket, send } = await pos(lab.printerPort('front')!);
    await send('Hola', LF, GS, 'V', 1);
    const snap = (await (await fetch(`${base}/api/snapshot`)).json()) as LabSnapshot;
    const printer = snap.printers[0];
    assert.equal(printer.config.id, 'front');
    assert.equal(printer.tickets.length, 1);
    assert.match(printer.status.client!.address, /127\.0\.0\.1/);
    const png = await fetch(`${base}/api/printers/front/tickets/${printer.tickets[0].id}.png`);
    assert.equal(png.headers.get('content-type'), 'image/png');
    assert.equal(Buffer.from(await png.arrayBuffer()).subarray(1, 4).toString(), 'PNG');
    socket.destroy();
  }));

test('a fault set from the panel is what the POS sees in DLE EOT, and recovery prints the pending data', () =>
  withLab(async (lab, base) => {
    const p = await pos(lab.printerPort('front')!);
    assert.equal((await fetch(`${base}/api/printers/front/faults`, json({ paperOut: true }))).status, 200);
    await p.send('pendiente', LF, DLE, 4, 4);
    assert.deepEqual(p.received, [0x7e]);
    let paper = await (await fetch(`${base}/api/snapshot`)).json();
    assert.equal(paper.printers[0].paper, null);
    await fetch(`${base}/api/printers/front/faults`, json({ paperOut: false }));
    paper = await (await fetch(`${base}/api/snapshot`)).json();
    assert.equal(paper.printers[0].paper.heightDots, 30);
    p.socket.destroy();
  }));

test('the WebSocket starts with a snapshot, then sends sequenced events; a new socket gets a fresh snapshot', () =>
  withLab(async (lab, base) => {
    const url = `${base.replace('http', 'ws')}/api/events`;
    const ws = new WebSocket(url, { headers: { origin: base } });
    const messages: ServerMessage[] = [];
    ws.on('message', (m) => messages.push(JSON.parse(String(m))));
    await once(ws, 'open');
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(messages[0].type, 'snapshot');

    await fetch(`${base}/api/printers/front/faults`, json({ coverOpen: true }));
    await new Promise((r) => setTimeout(r, 30));
    const events = messages.flatMap((m) => (m.type === 'event' ? [m.event] : []));
    const status = events.find((e) => e.type === 'printer.status');
    assert.ok(status && status.type === 'printer.status' && status.status.faults.coverOpen);
    assert.equal(status.deviceId, 'front');
    const seqs = events.map((e) => e.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
    ws.close();

    const again = new WebSocket(url, { headers: { origin: base } });
    const [first] = await once(again, 'message');
    const snap = JSON.parse(String(first)) as ServerMessage;
    assert.ok(snap.type === 'snapshot' && snap.snapshot.printers[0].status.faults.coverOpen);
    assert.ok(snap.snapshot.seq >= seqs.at(-1)!);
    again.close();
  }));

test('closing the panel does not touch the POS session', () =>
  withLab(async (lab, base) => {
    const p = await pos(lab.printerPort('front')!);
    const ws = new WebSocket(`${base.replace('http', 'ws')}/api/events`, { headers: { origin: base } });
    await once(ws, 'open');
    ws.close();
    await new Promise((r) => setTimeout(r, 30));
    await p.send(DLE, 4, 1);
    assert.deepEqual(p.received, [0x12]);
    p.socket.destroy();
  }));

test('disconnect drops the POS but keeps listening; power off stops listening', () =>
  withLab(async (lab, base) => {
    const port = lab.printerPort('front')!;
    const p = await pos(port);
    const closed = once(p.socket, 'close');
    assert.equal((await fetch(`${base}/api/printers/front/disconnect`, { method: 'POST' })).status, 200);
    await closed;
    (await pos(port)).socket.destroy();

    const res = await fetch(`${base}/api/printers/front/config`, { ...json({ enabled: false }), method: 'PATCH' });
    assert.equal(res.status, 200);
    const refused = connect(port, '127.0.0.1');
    const [err] = await once(refused, 'error');
    assert.equal((err as NodeJS.ErrnoException).code, 'ECONNREFUSED');
    const snap = await (await fetch(`${base}/api/snapshot`)).json();
    assert.equal(snap.printers[0].status.listening, false);
  }));

test('config changes are validated and persisted', () =>
  withLab(async (_lab, base) => {
    const patch = (body: unknown) => fetch(`${base}/api/printers/front/config`, { ...json(body), method: 'PATCH' });
    assert.equal((await patch({ port: 70000 })).status, 400);
    assert.equal((await patch({ paperWidth: 72 })).status, 400);
    assert.equal((await patch({ name: 'x'.repeat(200) })).status, 400);
    assert.equal((await patch({ bogus: 1 })).status, 400);
    assert.equal((await fetch(`${base}/api/printers/front/faults`, json({ paperOut: 'yes' }))).status, 400);
    assert.equal((await patch({ name: 'Mostrador', paperWidth: 58 })).status, 200);
    const snap = await (await fetch(`${base}/api/snapshot`)).json();
    assert.equal(snap.printers[0].config.name, 'Mostrador');
    assert.equal(snap.printers[0].config.paperWidth, 58);
    assert.equal((await fetch(`${base}/api/printers/nope/faults`, json({ paperOut: true }))).status, 404);
  }));

test('the self-test prints the sample ticket', () =>
  withLab(async (_lab, base) => {
    assert.equal((await fetch(`${base}/api/printers/front/self-test`, { method: 'POST' })).status, 200);
    const snap = await (await fetch(`${base}/api/snapshot`)).json();
    assert.equal(snap.printers[0].tickets.length, 1);
  }));

test('rejects foreign hosts and cross-origin requests', () =>
  withLab(async (lab, base) => {
    const port = lab.httpPort;
    const raw = (headers: Record<string, string>) =>
      new Promise<number>((resolve) => {
        const s = connect(port, '127.0.0.1', () =>
          s.write(`GET /api/snapshot HTTP/1.1\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('')}Connection: close\r\n\r\n`),
        );
        s.once('data', (d) => resolve(Number(String(d).split(' ')[1])));
      });
    assert.equal(await raw({ Host: 'evil.example' }), 403);
    assert.equal(await raw({ Host: `localhost:${port}`, Origin: 'https://evil.example' }), 403);
    assert.equal(await raw({ Host: `localhost:${port}` }), 200);
    const ws = new WebSocket(`${base.replace('http', 'ws')}/api/events`, { headers: { origin: 'https://evil.example' } });
    const [err] = await once(ws, 'error');
    assert.match(String(err), /403/);
  }));

test('serves the panel and falls back to index.html for client routes, without path traversal', () =>
  withLab(async (_lab, base) => {
    assert.match(await (await fetch(`${base}/`)).text(), /panel/);
    assert.match(await (await fetch(`${base}/tickets/abc`)).text(), /panel/);
    const traversal = await fetch(`${base}/..%2f..%2fetc%2fpasswd`);
    assert.doesNotMatch(await traversal.text(), /root:/);
    assert.equal((await fetch(`${base}/api/nope`)).status, 404);
  }));

test('ESC @ over TCP keeps the paper fault set from the panel', () =>
  withLab(async (lab, base) => {
    const p = await pos(lab.printerPort('front')!);
    await fetch(`${base}/api/printers/front/faults`, json({ paperNearEnd: true }));
    await p.send(ESC, '@', DLE, 4, 4);
    assert.deepEqual(p.received, [0x1e]);
    p.socket.destroy();
  }));

test('archived tickets can be deleted one by one or all at once, and the panel is told', () =>
  withLab(async (lab, base) => {
    const { socket, send } = await pos(lab.printerPort('front')!);
    await send('uno', LF, GS, 'V', 1, 'dos', LF, GS, 'V', 1, 'tres', LF, GS, 'V', 1);
    const ws = new WebSocket(`${base.replace('http', 'ws')}/api/events`, { headers: { origin: base } });
    const messages: ServerMessage[] = [];
    ws.on('message', (m) => messages.push(JSON.parse(String(m))));
    await once(ws, 'open');
    const tickets = (await (await fetch(`${base}/api/snapshot`)).json()).printers[0].tickets;
    assert.equal(tickets.length, 3);

    assert.equal((await fetch(`${base}/api/printers/front/tickets/${tickets[0].id}`, { method: 'DELETE' })).status, 200);
    assert.equal((await fetch(`${base}/api/printers/front/tickets/${tickets[0].id}.png`)).status, 404);
    assert.equal((await fetch(`${base}/api/printers/front/tickets`, { method: 'DELETE' })).status, 200);
    const after = (await (await fetch(`${base}/api/snapshot`)).json()).printers[0].tickets;
    assert.equal(after.length, 0);

    await new Promise((r) => setTimeout(r, 30));
    const deleted = messages.flatMap((m) => (m.type === 'event' && m.event.type === 'printer.tickets-deleted' ? m.event.ids : []));
    assert.deepEqual(deleted.sort(), tickets.map((t: { id: string }) => t.id).sort());
    ws.close();
    socket.destroy();
  }));
