import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import type { ScannerConfig } from '../../shared/contract.ts';
import { keyEvents } from './cdp.ts';
import { Scanner } from './scanner.ts';

/** A Chromium DevTools endpoint: /json/list and a page socket that records Input.dispatchKeyEvent. */
async function fakePos(title = 'Acme POS') {
  const typed: Record<string, unknown>[] = [];
  const hosts: string[] = [];
  const server: Server = createServer((req, res) => {
    hosts.push(req.headers.host ?? '');
    // Chromium answers DevTools only for Host localhost or an IP
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host ?? '')) return void res.writeHead(500).end('Host header is specified and is not an IP address or localhost.');
    const { port } = server.address() as AddressInfo;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify([
      { id: 'D', type: 'page', title: 'DevTools', url: 'devtools://devtools/bundled/inspector.html', webSocketDebuggerUrl: `ws://localhost:${port}/devtools/page/D` },
      { id: 'P', type: 'page', title, url: 'app://index.html', webSocketDebuggerUrl: `ws://localhost:${port}/devtools/page/P` },
    ]));
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws, req) => {
    hosts.push(req.headers.host ?? '');
    ws.on('message', (data) => {
      const message = JSON.parse(String(data));
      if (message.method === 'Input.dispatchKeyEvent') typed.push(message.params);
      ws.send(JSON.stringify({ id: message.id, result: {} }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { port: (server.address() as AddressInfo).port, typed, hosts, close: () => (wss.close(), server.close()) };
}

const config = (port: number): ScannerConfig => ({ id: 'hand', name: 'Scanner', enabled: true, cdpHost: '127.0.0.1', cdpPort: port, target: '', suffix: 'Enter', keyDelay: 0 });
const text = (events: Record<string, unknown>[]) => events.filter((e) => e.type === 'keyDown').map((e) => e.text).join('');

test('a scan types the code and Enter into the POS window as real key events', async () => {
  const pos = await fakePos();
  try {
    const scanner = new Scanner(config(pos.port), () => {});
    const result = await scanner.scan('8412345678905');
    assert.equal(result.delivered, true, result.detail);
    assert.equal(text(pos.typed), '8412345678905\r');
    assert.deepEqual(pos.typed[0], { type: 'keyDown', key: '8', code: 'Digit8', windowsVirtualKeyCode: 56, nativeVirtualKeyCode: 56, modifiers: 0, text: '8', unmodifiedText: '8' });
    assert.ok(pos.hosts.every((h) => h.startsWith('localhost:')), 'Host says localhost, as Chromium requires');
  } finally {
    pos.close();
  }
});

test('capitals and symbols are typed with Shift held, like a HID scanner', () => {
  const events = keyEvents('A-:', 'none');
  assert.deepEqual(events.map((e) => `${e.type}:${e.key}:${e.modifiers}`), [
    'rawKeyDown:Shift:8', 'keyDown:A:8', 'keyUp:A:8', 'keyUp:Shift:0',
    'keyDown:-:0', 'keyUp:-:0',
    'rawKeyDown:Shift:8', 'keyDown:::8', 'keyUp:::8', 'keyUp:Shift:0',
  ]);
  assert.equal(events.find((e) => e.key === ':')!.code, 'Semicolon');
});

test('the window can be chosen by title; no match and no POS are reported, not typed', async () => {
  const pos = await fakePos('Acme POS');
  try {
    const scanner = new Scanner({ ...config(pos.port), target: 'otra app' }, () => {});
    const missing = await scanner.scan('1');
    assert.equal(missing.delivered, false);
    assert.match(missing.detail, /No POS window contains “otra app”/);
    assert.equal(pos.typed.length, 0);
    scanner.applyConfig({ ...config(pos.port), target: 'acme', suffix: 'Tab' });
    assert.equal((await scanner.scan('42')).delivered, true);
    assert.equal(pos.typed.at(-2)!.key, 'Tab');
  } finally {
    pos.close();
  }
  const nobody = await new Scanner(config(1), () => {}).scan('1');
  assert.equal(nobody.delivered, false);
  assert.match(nobody.detail, /--remote-debugging-port=1/);
});
