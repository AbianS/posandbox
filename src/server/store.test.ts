import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.ts';
import type { TicketInfo } from '../shared/contract.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'posandbox-'));
const ticket = (id: string, printerId = 'front'): TicketInfo => ({
  id, printerId, startedAt: '2026-10-05T10:00:00.000Z', endedAt: '2026-10-05T10:00:01.000Z',
  end: 'cut', widthDots: 576, heightDots: 100, truncated: false,
});

test('returns the defaults when there is no saved config, and persists changes', () => {
  const dir = tmp();
  const defaults = { printers: [{ id: 'front', name: 'Front', enabled: true, port: 9100, paperWidth: 80 as const }], terminals: [], scanners: [] };
  assert.deepEqual(new Store(dir).loadConfig(defaults), defaults);

  const changed = { printers: [{ ...defaults.printers[0], port: 9200 }], terminals: [], scanners: [] };
  new Store(dir).saveConfig(changed);
  assert.deepEqual(new Store(dir).loadConfig(defaults), changed);
  assert.deepEqual(readdirSync(dir).filter((f) => f.includes('.tmp')), []);
});

test('falls back to defaults when the saved config is corrupt', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'config.json'), '{nope');
  const defaults = { printers: [], terminals: [], scanners: [] };
  assert.deepEqual(new Store(dir).loadConfig(defaults), defaults);
});

test('translates saved default device names and preserves custom names and settings', () => {
  const store = new Store(tmp());
  const printers = ['Impresora de tickets', 'constructor'].map((name, i) => ({ id: `printer-${i}`, name, enabled: false, port: 9200 + i, paperWidth: 58 as const }));
  const terminals = [{ id: 'counter', name: 'Datáfono', enabled: true, port: 8443, poiid: 'V400m-324688179', sharedKey: null, notificationUrl: null }];
  const scanners = [{ id: 'hand', name: 'Escáner', enabled: true, cdpHost: 'localhost', cdpPort: 9222, target: '', suffix: 'Enter' as const, keyDelay: 4 }];
  store.saveConfig({ printers, terminals, scanners });
  const config = store.loadConfig({ printers: [], terminals: [], scanners: [] });
  assert.deepEqual(config, {
    printers: [{ ...printers[0], name: 'Receipt printer' }, printers[1]],
    terminals: [{ ...terminals[0], name: 'Payment terminal' }],
    scanners: [{ ...scanners[0], name: 'Scanner' }],
  });
});

test('a config saved before a device existed gets that device from the defaults', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ printers: [] }));
  const terminal = { id: 'counter', name: 'Payment terminal', enabled: true, port: 8443, poiid: 'V400m-324688179', sharedKey: null, notificationUrl: null };
  assert.deepEqual(new Store(dir).loadConfig({ printers: [], terminals: [terminal], scanners: [] }).terminals, [terminal]);
});

test('saves tickets with their image and lists them newest first', () => {
  const store = new Store(tmp());
  store.saveTicket(ticket('a'), Buffer.from('png-a'));
  store.saveTicket(ticket('b'), Buffer.from('png-b'));
  store.saveTicket(ticket('x', 'kitchen'), Buffer.from('png-x'));
  assert.deepEqual(store.listTickets('front').map((t) => t.id), ['b', 'a']);
  assert.equal(store.readTicketImage('front', 'a')?.toString(), 'png-a');
});

test('keeps only the most recent tickets per printer', () => {
  const store = new Store(tmp(), 2);
  for (const id of ['a', 'b', 'c']) store.saveTicket(ticket(id), Buffer.from(id));
  assert.deepEqual(store.listTickets('front').map((t) => t.id), ['c', 'b']);
  assert.equal(store.readTicketImage('front', 'a'), undefined);
});

test('rejects ids that could escape the data directory', () => {
  const store = new Store(tmp());
  assert.equal(store.readTicketImage('front', '../config'), undefined);
  assert.equal(store.readTicketImage('../..', 'a'), undefined);
});

test('deletes one ticket or all the tickets of a printer', () => {
  const store = new Store(tmp());
  for (const id of ['a', 'b', 'c']) store.saveTicket(ticket(id), Buffer.from(id));
  store.saveTicket(ticket('k', 'kitchen'), Buffer.from('k'));
  assert.deepEqual(store.deleteTickets('front', ['b', '../x']), ['b']);
  assert.deepEqual(store.listTickets('front').map((t) => t.id), ['c', 'a']);
  assert.equal(store.readTicketImage('front', 'b'), undefined);
  assert.deepEqual(store.deleteTickets('front').sort(), ['a', 'c']);
  assert.deepEqual(store.listTickets('front'), []);
  assert.equal(store.listTickets('kitchen').length, 1);
});
