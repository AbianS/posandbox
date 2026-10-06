import { once } from 'node:events';
import { request } from 'node:http';
import WebSocket from 'ws';

// Minimal Chrome DevTools Protocol client: list the POS's windows and type into one of them with
// Input.dispatchKeyEvent, which feeds Chromium's real keyboard pipeline (trusted keydown/keypress/input/keyup).
// Chromium only answers DevTools requests whose Host is localhost or an IP (a DNS-rebinding guard); from
// Docker the POS is host.docker.internal, so every request says `Host: localhost`.

export interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

const hostHeader = (port: number) => `localhost:${port}`;

export function listTargets(host: string, port: number, timeoutMs = 2000): Promise<CdpTarget[]> {
  return new Promise((resolve, reject) => {
    const req = request({ host, port, path: '/json/list', headers: { host: hostHeader(port) }, timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8').on('data', (c) => (body += c)).on('end', () => {
        try {
          resolve(JSON.parse(body) as CdpTarget[]);
        } catch {
          reject(new Error(`unexpected response from ${host}:${port}/json/list (is this a DevTools port?)`));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`no response from ${host}:${port}`)));
    req.on('error', reject);
    req.end();
  });
}

/** The POS window: a page (not DevTools itself) whose title or URL contains `match` (any page when empty). */
export function pickTarget(targets: CdpTarget[], match: string): CdpTarget | undefined {
  const m = match.trim().toLowerCase();
  return targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && !t.url.startsWith('devtools://') && (!m || t.title.toLowerCase().includes(m) || t.url.toLowerCase().includes(m)));
}

/** Input.dispatchKeyEvent parameters. */
export type KeyEvent = Record<string, string | number>;

export async function dispatchKeys(host: string, port: number, target: CdpTarget, events: KeyEvent[], delayMs: number): Promise<void> {
  const url = new URL(target.webSocketDebuggerUrl!);
  url.hostname = host;
  url.port = String(port);
  const ws = new WebSocket(url, { headers: { Host: hostHeader(port) }, handshakeTimeout: 2000 });
  const pending = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();
  ws.on('message', (data) => {
    const message = JSON.parse(String(data)) as { id?: number; error?: { message: string } };
    const call = message.id !== undefined ? pending.get(message.id) : undefined;
    if (!call) return;
    pending.delete(message.id!);
    if (message.error) call.reject(new Error(message.error.message));
    else call.resolve();
  });
  await Promise.race([once(ws, 'open'), once(ws, 'error').then(([e]) => Promise.reject(e))]);
  let id = 0;
  try {
    for (const params of events) {
      await new Promise<void>((resolve, reject) => {
        pending.set(++id, { resolve, reject });
        ws.send(JSON.stringify({ id, method: 'Input.dispatchKeyEvent', params }));
      });
      if (delayMs > 0 && params.type === 'keyUp') await new Promise((r) => setTimeout(r, delayMs));
    }
  } finally {
    ws.close();
  }
}

// US keyboard layout, as a scanner in its default (US) keyboard language sends it.
const SHIFTED: Record<string, string> = { '!': '1', '@': '2', '#': '3', $: '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0', _: '-', '+': '=', '{': '[', '}': ']', '|': '\\', ':': ';', '"': "'", '<': ',', '>': '.', '?': '/', '~': '`' };
const PUNCTUATION: Record<string, [string, number]> = {
  '-': ['Minus', 189], '=': ['Equal', 187], '[': ['BracketLeft', 219], ']': ['BracketRight', 221], '\\': ['Backslash', 220], ';': ['Semicolon', 186],
  "'": ['Quote', 222], ',': ['Comma', 188], '.': ['Period', 190], '/': ['Slash', 191], '`': ['Backquote', 192], ' ': ['Space', 32],
};

function physical(ch: string): { code: string; vk: number; shift: boolean } {
  const base = SHIFTED[ch] ?? ch;
  const shift = ch in SHIFTED || (ch >= 'A' && ch <= 'Z');
  if (base >= '0' && base <= '9') return { code: `Digit${base}`, vk: base.charCodeAt(0), shift };
  if (/^[a-zA-Z]$/.test(base)) return { code: `Key${base.toUpperCase()}`, vk: base.toUpperCase().charCodeAt(0), shift };
  const p = PUNCTUATION[base];
  return p ? { code: p[0], vk: p[1], shift } : { code: '', vk: 0, shift: false };
}

const SHIFT = { key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, nativeVirtualKeyCode: 16 };

/** Key events a HID scanner produces for `data` plus its suffix: Shift held for capitals and symbols. */
export function keyEvents(data: string, suffix: 'Enter' | 'Tab' | 'none'): KeyEvent[] {
  const events: KeyEvent[] = [];
  for (const ch of data) {
    const { code, vk, shift } = physical(ch);
    const modifiers = shift ? 8 : 0;
    const key = { key: ch, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers };
    if (shift) events.push({ type: 'rawKeyDown', ...SHIFT, modifiers: 8 });
    events.push({ type: 'keyDown', ...key, text: ch, unmodifiedText: ch });
    events.push({ type: 'keyUp', ...key });
    if (shift) events.push({ type: 'keyUp', ...SHIFT, modifiers: 0 });
  }
  if (suffix === 'Enter') {
    const enter = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers: 0 };
    events.push({ type: 'keyDown', ...enter, text: '\r', unmodifiedText: '\r' }, { type: 'keyUp', ...enter });
  } else if (suffix === 'Tab') {
    const tab = { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9, modifiers: 0 };
    events.push({ type: 'rawKeyDown', ...tab }, { type: 'keyUp', ...tab });
  }
  return events;
}
