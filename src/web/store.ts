import { create } from 'zustand';
import type { EntryMode, LabEvent, LabSnapshot, PrinterConfigPatch, PrinterFault, PrinterSnapshot, ScannerConfigPatch, ScannerSnapshot, ServerMessage, TerminalBehaviour, TerminalConfigPatch, TerminalSnapshot, TestCardId } from '../shared/contract.ts';
import { applyEvent } from './lab-state.ts';

export type Connection = 'connecting' | 'live' | 'offline';

interface LabStore {
  snapshot: LabSnapshot | null;
  connection: Connection;
  /** Device the camera is focused on and whose detail panel is open; null = whole workbench. */
  focusedDeviceId: string | null;
  /** Resizable layout, remembered per browser. */
  layout: { sidebar: number; bottom: number };
  setLayout(patch: Partial<{ sidebar: number; bottom: number }>): void;
  /** Ticket open in the 2D viewer: an archived ticket id, or 'paper' for the paper still in the printer. */
  viewer: { printerId: string; ticketId: string } | null;
  error: string | null;
  /** Paper animation at the real 250 mm/s, or slowed down to watch it print. Per-browser preference. */
  realSpeed: boolean;
  setRealSpeed(on: boolean): void;
  focus(deviceId: string | null): void;
  openViewer(printerId: string, ticketId: string): void;
  closeViewer(): void;
  dismissError(): void;
}

export const useLab = create<LabStore>()((set) => ({
  snapshot: null,
  connection: 'connecting',
  focusedDeviceId: null,
  layout: { sidebar: 380, bottom: 260, ...readJson('posandbox.layout') },
  setLayout: (patch) =>
    set((s) => {
      const layout = { ...s.layout, ...patch };
      writePreference('posandbox.layout', JSON.stringify(layout));
      return { layout };
    }),
  viewer: null,
  error: null,
  realSpeed: readPreference('posandbox.realSpeed') === 'true',
  setRealSpeed: (realSpeed) => {
    writePreference('posandbox.realSpeed', String(realSpeed));
    set({ realSpeed });
  },
  focus: (focusedDeviceId) => set({ focusedDeviceId }),
  openViewer: (printerId, ticketId) => set({ viewer: { printerId, ticketId } }),
  closeViewer: () => set({ viewer: null }),
  dismissError: () => set({ error: null }),
}));

function readJson(key: string): object {
  try {
    return JSON.parse(readPreference(key) ?? '{}') as object;
  } catch {
    return {};
  }
}

function readPreference(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writePreference(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage unavailable: the preference lasts for this page only
  }
}

/** The focused printer, if the focus is on a printer. */
export function useFocusedPrinter(): PrinterSnapshot | undefined {
  return useLab((s) => s.snapshot?.printers.find((p) => p.config.id === s.focusedDeviceId));
}

/** Focus id of the cash drawer: its own device in the panel, wired to the first printer's drawer-kick connector. */
export const DRAWER_ID = 'cash-drawer';

/** When the drawer is focused: the printer it hangs on (it holds the drawer's state). */
export function useFocusedDrawer(): PrinterSnapshot | undefined {
  return useLab((s) => (s.focusedDeviceId === DRAWER_ID ? s.snapshot?.printers[0] : undefined));
}

/** The focused payment terminal. */
export function useFocusedTerminal(): TerminalSnapshot | undefined {
  return useLab((s) => s.snapshot?.terminals.find((t) => t.config.id === s.focusedDeviceId));
}

/** The focused barcode scanner. */
export function useFocusedScanner(): ScannerSnapshot | undefined {
  return useLab((s) => s.snapshot?.scanners.find((t) => t.config.id === s.focusedDeviceId));
}

/** The focused printer, or the first one (for views that always show a printer, like the tickets tray). */
export function useSelectedPrinter(): PrinterSnapshot | undefined {
  return useLab((s) => s.snapshot?.printers.find((p) => p.config.id === s.focusedDeviceId) ?? s.snapshot?.printers[0]);
}

// ---- live connection ----

type Listener = (event: LabEvent) => void;
const listeners = new Set<Listener>();

/** Raw event stream, for animations that react to moments (a cut) rather than to state. */
export function onLabEvent(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function connectLab(): () => void {
  let socket: WebSocket | null = null;
  let retry = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const open = () => {
    useLab.setState({ connection: 'connecting' });
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/events`;
    const ws = (socket = new WebSocket(url));
    ws.onmessage = (message) => {
      const data = JSON.parse(String(message.data)) as ServerMessage;
      if (data.type === 'snapshot') {
        retry = 0;
        useLab.setState({ snapshot: data.snapshot, connection: 'live' });
        return;
      }
      const current = useLab.getState().snapshot;
      if (!current) return;
      const next = applyEvent(current, data.event);
      if (next === 'gap') return ws.close(); // reconnect = fresh snapshot
      if (next !== current) {
        useLab.setState({ snapshot: next });
        for (const fn of listeners) fn(data.event);
      }
    };
    ws.onclose = () => {
      if (stopped) return;
      useLab.setState({ connection: 'offline' });
      timer = setTimeout(open, Math.min(500 * 2 ** retry++, 5000));
    };
  };

  open();
  return () => {
    stopped = true;
    clearTimeout(timer);
    socket?.close();
  };
}

// ---- commands ----

async function call(method: string, path: string, body?: unknown): Promise<boolean> {
  try {
    const res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.ok) return true;
    const { error } = (await res.json().catch(() => ({}))) as { error?: string };
    useLab.setState({ error: error ?? `Error ${res.status}` });
  } catch {
    useLab.setState({ error: 'Cannot connect to the lab' });
  }
  return false;
}

const printerPath = (id: string) => `/api/printers/${encodeURIComponent(id)}`;

export const api = {
  setFaults: (id: string, patch: Partial<Record<PrinterFault, boolean>>) => call('PUT', `${printerPath(id)}/faults`, patch),
  updateConfig: (id: string, patch: PrinterConfigPatch) => call('PATCH', `${printerPath(id)}/config`, patch),
  /** The cashier's hand: close the drawer, or open it with the key. */
  setDrawer: (id: string, open: boolean) => call('PUT', `${printerPath(id)}/drawer`, { open }),
  action: (id: string, action: 'disconnect' | 'self-test' | 'tear-off' | 'feed') => call('POST', `${printerPath(id)}/${action}`),
  /** Deletes one archived ticket, or all of them when `ticketId` is omitted. */
  deleteTickets: (id: string, ticketId?: string) =>
    call('DELETE', `${printerPath(id)}/tickets${ticketId ? `/${encodeURIComponent(ticketId)}` : ''}`),
};

const terminalPath = (id: string) => `/api/terminals/${encodeURIComponent(id)}`;

export const terminalApi = {
  updateConfig: (id: string, patch: TerminalConfigPatch) => call('PATCH', `${terminalPath(id)}/config`, patch),
  setBehaviour: (id: string, patch: Partial<TerminalBehaviour>) => call('PUT', `${terminalPath(id)}/behaviour`, patch),
  /** The shopper taps, inserts or swipes a test card. */
  present: (id: string, card: TestCardId, entry: EntryMode) => call('POST', `${terminalPath(id)}/present`, { card, entry }),
  key: (id: string, key: string) => call('POST', `${terminalPath(id)}/key`, { key }),
  removeCard: (id: string) => call('POST', `${terminalPath(id)}/remove-card`),
  caUrl: (id: string) => `${terminalPath(id)}/ca.pem`,
};

const scannerPath = (id: string) => `/api/scanners/${encodeURIComponent(id)}`;

export const scannerApi = {
  updateConfig: (id: string, patch: ScannerConfigPatch) => call('PATCH', `${scannerPath(id)}/config`, patch),
  /** Pulls the trigger on a code: the scanner types it into the POS window. */
  scan: (id: string, data: string) => call('POST', `${scannerPath(id)}/scan`, { data }),
  probe: (id: string) => call('POST', `${scannerPath(id)}/probe`),
};

export const ticketImageUrl = (printerId: string, ticketId: string) => `${printerPath(printerId)}/tickets/${ticketId}.png`;
export const paperImageUrl = (printerId: string, height: number) => `${printerPath(printerId)}/paper.png?h=${height}`;
