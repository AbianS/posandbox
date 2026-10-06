import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { WebSocketServer } from 'ws';
import {
  ISSUER_OUTCOMES,
  PAPER_WIDTHS,
  PRINTER_FAULTS,
  TEST_CARDS,
  type EntryMode,
  type PaperWidth,
  type PrinterConfigPatch,
  type PrinterFault,
  type ServerMessage,
  type ScannerConfigPatch,
  type TerminalBehaviour,
  type TerminalConfigPatch,
  type TestCardId,
} from '../shared/contract.ts';
import { isAllowedRequest, RateLimiter } from './guard.ts';
import { NotFound, type Lab } from './lab.ts';

export interface HttpOptions {
  lab: Lab;
  staticDir: string;
  allowedHosts: string[];
  sampleTicket: Uint8Array;
}

class BadRequest extends Error {}

const MAX_BODY = 8 * 1024;
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.hdr': 'application/octet-stream', '.json': 'application/json', '.woff2': 'font/woff2',
};

/**
 * Control API of the lab (the POS never uses it: it only talks ESC/POS over TCP).
 *   GET   /api/snapshot                         full state
 *   PATCH /api/printers/:id/config              { name?, enabled?, port?, paperWidth? }
 *   PUT   /api/printers/:id/faults              { paperOut?: boolean, ... }
 *   POST  /api/printers/:id/{disconnect|self-test|tear-off|feed}
 *   PUT   /api/printers/:id/drawer              { open: boolean }  the cashier's hand (close) or key (open)
 *   GET   /api/printers/:id/paper.png           paper still in the printer
 *   GET   /api/printers/:id/tickets/:ticket.png archived ticket
 *   DELETE /api/printers/:id/tickets[/:ticket]  delete one or all archived tickets
 *   PATCH /api/terminals/:id/config             { name?, enabled?, port?, poiid?, sharedKey?, notificationUrl? }
 *   PUT   /api/terminals/:id/behaviour          { shopper?, issuer?, responseLost? }
 *   POST  /api/terminals/:id/present            { card, entry }  the shopper taps, inserts or swipes
 *   POST  /api/terminals/:id/key                { key: 0-9 | clear | enter | cancel }
 *   POST  /api/terminals/:id/remove-card
 *   GET   /api/terminals/:id/ca.pem             CA the POS must trust
 *   PATCH /api/scanners/:id/config              { name?, enabled?, cdpHost?, cdpPort?, target?, suffix?, keyDelay? }
 *   POST  /api/scanners/:id/scan                { data }  pulls the trigger: types it into the POS window
 *   POST  /api/scanners/:id/probe               looks for the POS window
 *   WS    /api/events                           snapshot, then sequenced events
 */
export function createHttpServer({ lab, staticDir, allowedHosts, sampleTicket }: HttpOptions): Server {
  const limiter = new RateLimiter(600, 10_000);

  const routes: [string, RegExp, (m: string[], req: IncomingMessage, res: ServerResponse) => Promise<void> | void][] = [
    ['GET', /^\/api\/health$/, (_m, _q, res) => send(res, 200, { ok: true })],
    ['GET', /^\/api\/snapshot$/, (_m, _q, res) => send(res, 200, lab.snapshot())],
    ['PATCH', /^\/api\/printers\/([\w-]+)\/config$/, async ([id], req, res) => {
      const patch = parseConfigPatch(await readJson(req));
      send(res, 200, await lab.updateConfig(id, patch));
    }],
    ['PUT', /^\/api\/printers\/([\w-]+)\/faults$/, async ([id], req, res) => {
      lab.setFaults(id, parseFaults(await readJson(req)));
      send(res, 200, lab.printer(id)!.status());
    }],
    ['PUT', /^\/api\/printers\/([\w-]+)\/drawer$/, async ([id], req, res) => {
      const { open } = (await readJson(req)) as { open?: unknown };
      if (typeof open !== 'boolean') throw new BadRequest('open must be a boolean');
      printer(id).setDrawer(open);
      send(res, 200, printer(id).status());
    }],
    ['POST', /^\/api\/printers\/([\w-]+)\/disconnect$/, ([id], _q, res) => {
      lab.disconnect(id);
      send(res, 200, { ok: true });
    }],
    ['POST', /^\/api\/printers\/([\w-]+)\/self-test$/, ([id], _q, res) => {
      const ok = printer(id).selfTest(sampleTicket);
      send(res, ok ? 200 : 409, ok ? { ok } : { error: 'The printer is processing POS data' });
    }],
    ['POST', /^\/api\/printers\/([\w-]+)\/tear-off$/, ([id], _q, res) => {
      printer(id).tearOff();
      send(res, 200, { ok: true });
    }],
    ['POST', /^\/api\/printers\/([\w-]+)\/feed$/, ([id], _q, res) => {
      printer(id).feedButton();
      send(res, 200, { ok: true });
    }],
    ['PATCH', /^\/api\/terminals\/([\w-]+)\/config$/, async ([id], req, res) => {
      const patch = parseTerminalPatch(await readJson(req));
      send(res, 200, await lab.updateTerminalConfig(id, patch));
    }],
    ['PUT', /^\/api\/terminals\/([\w-]+)\/behaviour$/, async ([id], req, res) => {
      terminal(id).setBehaviour(parseBehaviour(await readJson(req)));
      send(res, 200, terminal(id).status());
    }],
    ['POST', /^\/api\/terminals\/([\w-]+)\/present$/, async ([id], req, res) => {
      const { card, entry } = object(await readJson(req));
      if (!TEST_CARDS.some((c) => c.id === card) || !['Contactless', 'ICC', 'MagStripe'].includes(entry as string)) throw new BadRequest('Invalid card or entry mode');
      const refused = terminal(id).present(card as TestCardId, entry as EntryMode);
      send(res, refused ? 409 : 200, refused ? { error: refused } : { ok: true });
    }],
    ['POST', /^\/api\/terminals\/([\w-]+)\/key$/, async ([id], req, res) => {
      const { key } = object(await readJson(req));
      if (typeof key !== 'string' || !/^([0-9]|clear|enter|cancel)$/.test(key)) throw new BadRequest('Invalid key');
      terminal(id).key(key);
      send(res, 200, { ok: true });
    }],
    ['POST', /^\/api\/terminals\/([\w-]+)\/remove-card$/, ([id], _q, res) => {
      terminal(id).removeCard();
      send(res, 200, { ok: true });
    }],
    ['GET', /^\/api\/terminals\/([\w-]+)\/ca\.pem$/, ([id], _q, res) => {
      const pem = lab.terminalCa(id);
      if (!pem) throw new NotFound(id);
      res.writeHead(200, { 'content-type': 'application/x-pem-file', 'content-disposition': 'attachment; filename="posandbox-terminal-ca.pem"' });
      res.end(pem);
    }],
    ['PATCH', /^\/api\/scanners\/([\w-]+)\/config$/, async ([id], req, res) => {
      send(res, 200, lab.updateScannerConfig(id, parseScannerPatch(await readJson(req))));
    }],
    ['POST', /^\/api\/scanners\/([\w-]+)\/scan$/, async ([id], req, res) => {
      const { data } = object(await readJson(req));
      // printable characters only: a scanner types what a keyboard can
      if (typeof data !== 'string' || !data || data.length > 2000 || /[\u0000-\u001f\u007f]/.test(data)) throw new BadRequest('Invalid barcode');
      send(res, 200, await scanner(id).scan(data));
    }],
    ['POST', /^\/api\/scanners\/([\w-]+)\/probe$/, async ([id], _q, res) => {
      send(res, 200, await scanner(id).probe());
    }],
    ['GET', /^\/api\/printers\/([\w-]+)\/paper\.png$/, ([id], _q, res) => png(res, printer(id).paperPng(), false)],
    ['DELETE', /^\/api\/printers\/([\w-]+)\/tickets(?:\/([\w-]+))?$/, ([id, ticket], _q, res) => {
      send(res, 200, { deleted: lab.deleteTickets(id, ticket ? [ticket] : undefined) });
    }],
    ['GET', /^\/api\/printers\/([\w-]+)\/tickets\/([\w-]+)\.png$/, ([id, ticket], _q, res) => {
      const image = lab.store.readTicketImage(id, ticket);
      if (!image) throw new NotFound(ticket);
      png(res, image, true);
    }],
  ];

  const printer = (id: string) => {
    const p = lab.printer(id);
    if (!p) throw new NotFound(id);
    return p;
  };

  const terminal = (id: string) => {
    const t = lab.terminal(id);
    if (!t) throw new NotFound(id);
    return t;
  };

  const scanner = (id: string) => {
    const s = lab.scanner(id);
    if (!s) throw new NotFound(id);
    return s;
  };

  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (!isAllowedRequest(req.headers, allowedHosts)) return send(res, 403, { error: 'Host or origin not allowed' });
    const url = new URL(req.url ?? '/', 'http://lab');
    if (!url.pathname.startsWith('/api/')) return serveStatic(staticDir, url.pathname, res);
    if (!limiter.take(req.socket.remoteAddress ?? '')) return send(res, 429, { error: 'Too many requests' });

    try {
      for (const [method, pattern, handler] of routes) {
        const match = pattern.exec(url.pathname);
        if (match && req.method === method) return await handler(match.slice(1), req, res);
      }
      send(res, 404, { error: 'Not found' });
    } catch (error) {
      if (error instanceof BadRequest) send(res, 400, { error: error.message });
      else if (error instanceof NotFound) send(res, 404, { error: 'Not found' });
      else {
        console.error(error);
        send(res, 500, { error: 'Internal error' });
      }
    }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url ?? '/', 'http://lab').pathname !== '/api/events' || !isAllowedRequest(req.headers, allowedHosts)) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const push = (message: ServerMessage) => ws.send(JSON.stringify(message));
      push({ type: 'snapshot', snapshot: lab.snapshot() });
      const unsubscribe = lab.subscribe((event) => push({ type: 'event', event }));
      ws.on('close', unsubscribe);
      ws.on('error', unsubscribe);
    });
  });
  server.on('close', () => wss.close());
  return server;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function png(res: ServerResponse, image: Buffer, immutable: boolean): void {
  res.writeHead(200, { 'content-type': 'image/png', 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-store' });
  res.end(image);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new BadRequest('Expected application/json');
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new BadRequest('Request body too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new BadRequest('Invalid JSON');
  }
}

function object(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequest('Expected an object');
  return body as Record<string, unknown>;
}

export function parseConfigPatch(body: unknown): PrinterConfigPatch {
  const input = object(body);
  const patch: PrinterConfigPatch = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === 'name' && typeof value === 'string' && value.trim().length >= 1 && value.length <= 40) patch.name = value.trim();
    else if (key === 'enabled' && typeof value === 'boolean') patch.enabled = value;
    else if (key === 'port' && Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 65535) patch.port = value as number;
    else if (key === 'paperWidth' && PAPER_WIDTHS.includes(value as PaperWidth)) patch.paperWidth = value as PaperWidth;
    else throw new BadRequest(`Invalid value for ${key}`);
  }
  return patch;
}

export function parseFaults(body: unknown): Partial<Record<PrinterFault, boolean>> {
  const input = object(body);
  const patch: Partial<Record<PrinterFault, boolean>> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!PRINTER_FAULTS.includes(key as PrinterFault) || typeof value !== 'boolean') throw new BadRequest(`Invalid value for ${key}`);
    patch[key as PrinterFault] = value;
  }
  return patch;
}

const POIID = /^[A-Za-z0-9]{3,}-[0-9]{9,15}$/;

export function parseTerminalPatch(body: unknown): TerminalConfigPatch {
  const patch: TerminalConfigPatch = {};
  for (const [key, value] of Object.entries(object(body))) {
    if (key === 'name' && typeof value === 'string' && value.trim().length >= 1 && value.length <= 40) patch.name = value.trim();
    else if (key === 'enabled' && typeof value === 'boolean') patch.enabled = value;
    else if (key === 'port' && Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 65535) patch.port = value as number;
    // model-serial with a numeric serial: the only shape every Adyen library accepts in the certificate
    else if (key === 'poiid' && typeof value === 'string' && POIID.test(value)) patch.poiid = value;
    else if (key === 'sharedKey' && value === null) patch.sharedKey = null;
    else if (key === 'notificationUrl' && value === null) patch.notificationUrl = null;
    else if (key === 'notificationUrl' && typeof value === 'string' && /^https?:\/\/\S+$/.test(value) && value.length <= 300) patch.notificationUrl = value;
    else if (key === 'sharedKey' && value && typeof value === 'object') {
      const { keyIdentifier, passphrase, keyVersion } = value as Record<string, unknown>;
      if (typeof keyIdentifier !== 'string' || !keyIdentifier || typeof passphrase !== 'string' || !passphrase || !Number.isInteger(keyVersion)) {
        throw new BadRequest('The shared key requires an identifier, passphrase and version');
      }
      patch.sharedKey = { keyIdentifier, passphrase, keyVersion: keyVersion as number };
    } else throw new BadRequest(`Invalid value for ${key}`);
  }
  return patch;
}

export function parseScannerPatch(body: unknown): ScannerConfigPatch {
  const patch: ScannerConfigPatch = {};
  for (const [key, value] of Object.entries(object(body))) {
    if (key === 'name' && typeof value === 'string' && value.trim().length >= 1 && value.length <= 40) patch.name = value.trim();
    else if (key === 'enabled' && typeof value === 'boolean') patch.enabled = value;
    else if (key === 'cdpHost' && typeof value === 'string' && /^[A-Za-z0-9.-]{1,253}$/.test(value)) patch.cdpHost = value;
    else if (key === 'cdpPort' && Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 65535) patch.cdpPort = value as number;
    else if (key === 'target' && typeof value === 'string' && value.length <= 100) patch.target = value;
    else if (key === 'suffix' && (value === 'Enter' || value === 'Tab' || value === 'none')) patch.suffix = value;
    else if (key === 'keyDelay' && Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 200) patch.keyDelay = value as number;
    else throw new BadRequest(`Invalid value for ${key}`);
  }
  return patch;
}

export function parseBehaviour(body: unknown): Partial<TerminalBehaviour> {
  const patch: Partial<TerminalBehaviour> = {};
  for (const [key, value] of Object.entries(object(body))) {
    if (key === 'shopper' && (value === 'manual' || value === 'auto')) patch.shopper = value;
    else if (key === 'issuer' && (value === 'amount' || value === 'approve' || value === 'timeout' || (typeof value === 'string' && value in ISSUER_OUTCOMES))) patch.issuer = value as TerminalBehaviour['issuer'];
    else if (key === 'responseLost' && typeof value === 'boolean') patch.responseLost = value;
    else throw new BadRequest(`Invalid value for ${key}`);
  }
  return patch;
}

async function serveStatic(root: string, pathname: string, res: ServerResponse): Promise<void> {
  let file: string;
  try {
    file = normalize(join(root, decodeURIComponent(pathname)));
  } catch {
    return send(res, 400, { error: 'Invalid path' });
  }
  const inside = file === root || file.startsWith(root.endsWith(sep) ? root : root + sep);
  const candidates = inside && extname(file) ? [file, join(root, 'index.html')] : [join(root, 'index.html')];
  for (const candidate of candidates) {
    try {
      const body = await readFile(candidate);
      const hashed = candidate.includes(`${sep}assets${sep}`);
      res.writeHead(200, {
        'content-type': TYPES[extname(candidate)] ?? 'application/octet-stream',
        'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
      });
      return void res.end(body);
    } catch {
      // try the next candidate
    }
  }
  send(res, 404, { error: 'Panel not built: run pnpm build' });
}
