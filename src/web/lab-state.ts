import type { LabEvent, LabSnapshot, PrinterEvent, PrinterSnapshot, ScannerEvent, ScannerSnapshot, TerminalEvent, TerminalSnapshot } from '../shared/contract.ts';

const INSPECTOR_SIZE = 400;

/**
 * Folds one sequenced event into the snapshot. Returns 'gap' when an event was missed:
 * the panel then asks for a fresh snapshot instead of guessing.
 */
export function applyEvent(state: LabSnapshot, event: LabEvent): LabSnapshot | 'gap' {
  if (event.seq <= state.seq) return state;
  if (event.seq !== state.seq + 1) return 'gap';
  if (event.type.startsWith('scanner.')) {
    const scanners = state.scanners.map((s) => (s.config.id === event.deviceId ? applyScannerEvent(s, event as ScannerEvent) : s));
    return { ...state, seq: event.seq, scanners };
  }
  if (event.type.startsWith('terminal.')) {
    const terminals = state.terminals.map((t) => (t.config.id === event.deviceId ? applyTerminalEvent(t, event as TerminalEvent) : t));
    return { ...state, seq: event.seq, terminals };
  }
  const printers = state.printers.map((p) => (p.config.id === event.deviceId ? applyPrinterEvent(p, event as PrinterEvent) : p));
  return { ...state, seq: event.seq, printers };
}

function applyScannerEvent(s: ScannerSnapshot, event: ScannerEvent): ScannerSnapshot {
  switch (event.type) {
    case 'scanner.config': return { ...s, config: event.config };
    case 'scanner.status': return { ...s, status: event.status };
    case 'scanner.scan': return { ...s, scans: [event.scan, ...s.scans].slice(0, 50) };
  }
}

function applyTerminalEvent(t: TerminalSnapshot, event: TerminalEvent): TerminalSnapshot {
  switch (event.type) {
    case 'terminal.config': return { ...t, config: event.config };
    case 'terminal.status': return { ...t, status: event.status };
    case 'terminal.transaction': return { ...t, transactions: [event.transaction, ...t.transactions].slice(0, 100) };
    case 'terminal.inspector': return { ...t, inspector: [...t.inspector, ...event.entries].slice(-INSPECTOR_SIZE) };
  }
}

function applyPrinterEvent(p: PrinterSnapshot, event: PrinterEvent): PrinterSnapshot {
  switch (event.type) {
    case 'printer.config': return { ...p, config: event.config };
    case 'printer.status': return { ...p, status: event.status };
    case 'printer.paper': return { ...p, paper: event.paper };
    case 'printer.ticket': return { ...p, tickets: [event.ticket, ...p.tickets.filter((t) => t.id !== event.ticket.id)] };
    case 'printer.tickets-deleted': return { ...p, tickets: p.tickets.filter((t) => !event.ids.includes(t.id)) };
    case 'printer.inspector': return { ...p, inspector: [...p.inspector, ...event.entries].slice(-INSPECTOR_SIZE) };
  }
}
