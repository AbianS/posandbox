import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEvent } from './lab-state.ts';
import type { LabEvent, LabSnapshot, PrinterSnapshot, TicketInfo } from '../shared/contract.ts';

const printer = (id: string): PrinterSnapshot => ({
  config: { id, name: id, enabled: true, port: 9100, paperWidth: 80 },
  status: {
    listening: true, listenError: null, client: null, online: true, pendingBytes: 0, asbEnabled: false, drawerOpen: false,
    faults: { paperNearEnd: false, paperOut: false, coverOpen: false, headOverheat: false },
  },
  paper: null,
  tickets: [],
  inspector: [],
});
const snap: LabSnapshot = { seq: 10, printers: [printer('front'), printer('kitchen')], terminals: [], scanners: [] };
const ticket = (id: string): TicketInfo => ({
  id, printerId: 'front', startedAt: 'a', endedAt: 'b', end: 'cut', widthDots: 576, heightDots: 90, truncated: false,
});

test('applies an event to the device it belongs to', () => {
  const event: LabEvent = { seq: 11, deviceId: 'kitchen', type: 'printer.status', status: { ...snap.printers[1].status, online: false } };
  const next = applyEvent(snap, event);
  assert.ok(next !== 'gap');
  assert.equal(next.seq, 11);
  assert.equal(next.printers[1].status.online, false);
  assert.equal(next.printers[0], snap.printers[0], 'other devices untouched');
});

test('ignores events already contained in the snapshot', () => {
  const event: LabEvent = { seq: 10, deviceId: 'front', type: 'printer.paper', paper: null };
  assert.equal(applyEvent(snap, event), snap);
});

test('reports a gap when an event was missed, so the client refetches the snapshot', () => {
  const event: LabEvent = { seq: 12, deviceId: 'front', type: 'printer.paper', paper: null };
  assert.equal(applyEvent(snap, event), 'gap');
});

test('new tickets go first and the inspector keeps a bounded tail', () => {
  let state: LabSnapshot | 'gap' = applyEvent(snap, { seq: 11, deviceId: 'front', type: 'printer.ticket', ticket: ticket('t1') });
  assert.ok(state !== 'gap');
  state = applyEvent(state, { seq: 12, deviceId: 'front', type: 'printer.ticket', ticket: ticket('t2') });
  assert.ok(state !== 'gap');
  assert.deepEqual(state.printers[0].tickets.map((t) => t.id), ['t2', 't1']);
  const entries = Array.from({ length: 450 }, (_, i) => ({ seq: i, at: '', kind: 'info' as const, label: `${i}`, hex: '' }));
  state = applyEvent(state, { seq: 13, deviceId: 'front', type: 'printer.inspector', entries });
  assert.ok(state !== 'gap');
  assert.equal(state.printers[0].inspector.length, 400);
  assert.equal(state.printers[0].inspector.at(-1)!.label, '449');
});

test('config and paper events replace their part', () => {
  const paper = { ...ticket('p'), endedAt: null, end: null };
  let state = applyEvent(snap, { seq: 11, deviceId: 'front', type: 'printer.paper', paper });
  assert.ok(state !== 'gap');
  assert.equal(state.printers[0].paper, paper);
  state = applyEvent(state, { seq: 12, deviceId: 'front', type: 'printer.config', config: { ...snap.printers[0].config, name: 'Barra' } });
  assert.ok(state !== 'gap');
  assert.equal(state.printers[0].config.name, 'Barra');
});

test('deleted tickets disappear from the list', () => {
  let state = applyEvent(snap, { seq: 11, deviceId: 'front', type: 'printer.ticket', ticket: ticket('t1') });
  assert.ok(state !== 'gap');
  state = applyEvent(state, { seq: 12, deviceId: 'front', type: 'printer.ticket', ticket: ticket('t2') });
  assert.ok(state !== 'gap');
  state = applyEvent(state, { seq: 13, deviceId: 'front', type: 'printer.tickets-deleted', ids: ['t1'] });
  assert.ok(state !== 'gap');
  assert.deepEqual(state.printers[0].tickets.map((t) => t.id), ['t2']);
});
