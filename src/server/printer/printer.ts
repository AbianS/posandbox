import {
  PRINTER_FAULTS,
  type InspectorEntry,
  type PrinterConfig,
  type PrinterEvent,
  type PrinterFault,
  type PrinterSnapshot,
  type PrinterStatus,
  type Support,
  type TicketEnd,
  type TicketInfo,
} from '../../shared/contract.ts';
import { CODE_PAGES } from './escpos/codepages.ts';
import { Parser, type Token } from './escpos/parser.ts';
import { RealtimeScanner, type RealtimeCommand } from './escpos/realtime.ts';
import { asb, dleEot, gsI, gsR, isOffline, type StatusState } from './escpos/status.ts';
import type { TcpDevice } from './tcp.ts';
import { PrintEngine } from './print-engine.ts';
import { Bitmap } from './render/bitmap.ts';

export const DOTS_PER_LINE = { 80: 576, 58: 420 } as const;
/** Received-but-unexecuted bytes kept while offline before TCP backpressure kicks in. */
const RECEIVE_BUFFER = 64 * 1024;
const INSPECTOR_SIZE = 400;
const HEX_PREVIEW = 48;

export interface TicketSink {
  saveTicket(info: TicketInfo, png: Buffer): void;
}

interface Session {
  address: string;
  since: string;
  transmit: (bytes: Uint8Array) => void;
}

/**
 * Virtual Epson TM-T20III. Owns everything the POS can observe: status, faults, buffers and paper.
 * Bytes go through three stages: received (real-time commands act immediately), tokenised into
 * complete commands, and executed — only while online. Printing happens on execution.
 */
export class Printer implements TcpDevice {
  config: PrinterConfig;
  readonly #sink: TicketSink;
  readonly #emit: (event: PrinterEvent) => void;

  #faults: Record<PrinterFault, boolean> = Object.fromEntries(PRINTER_FAULTS.map((f) => [f, false])) as Record<PrinterFault, boolean>;
  #feeding = false;
  #asbMask = 0;
  #pulseEnabled = true; // GS ( D: real-time drawer pulse
  /** Cash drawer on connector pin 2: the pulse releases the latch and its spring pushes it open; only a hand closes it. */
  #drawerOpen = false;
  #network = { listening: false, listenError: null as string | null };
  #session: Session | null = null;

  #scanner = new RealtimeScanner();
  #parser = new Parser();
  #queue: Token[] = [];
  #queuedBytes = 0;
  #engine: PrintEngine;
  #paper: { bitmap: Bitmap; info: TicketInfo } | null = null;

  #inspector: InspectorEntry[] = [];
  #inspectorSeq = 0;
  #newEntries: InspectorEntry[] = [];
  #lastStatus = '';
  #lastPaperHeight = 0;
  #ticketSeq = 0;

  constructor(config: PrinterConfig, sink: TicketSink, emit: (event: PrinterEvent) => void) {
    this.config = config;
    this.#sink = sink;
    this.#emit = emit;
    this.#engine = this.#newEngine();
    this.#lastStatus = JSON.stringify(this.status());
  }

  // ---- state seen by the panel ----

  get widthDots(): number {
    return DOTS_PER_LINE[this.config.paperWidth];
  }

  get online(): boolean {
    return !isOffline(this.#statusState());
  }

  get paperHeight(): number {
    return this.#paper?.bitmap.height ?? 0;
  }

  get accepting(): boolean {
    return this.online || this.#pendingBytes() < RECEIVE_BUFFER;
  }

  status(): PrinterStatus {
    return {
      ...this.#network,
      client: this.#session && { address: this.#session.address, since: this.#session.since },
      faults: { ...this.#faults },
      online: this.online,
      pendingBytes: this.#pendingBytes(),
      asbEnabled: this.#asbMask !== 0,
      drawerOpen: this.#drawerOpen,
    };
  }

  snapshot(tickets: TicketInfo[] = []): PrinterSnapshot {
    return { config: this.config, status: this.status(), paper: this.#paperInfo(), tickets, inspector: [...this.#inspector] };
  }

  paperPng(): Buffer {
    return (this.#paper?.bitmap ?? new Bitmap(this.widthDots)).toPng();
  }

  // ---- TCP session (TcpDevice) ----

  open(address: string, transmit: (bytes: Uint8Array) => void): boolean {
    if (this.#session) return false;
    this.#session = { address, since: new Date().toISOString(), transmit };
    this.#log('info', `Connection opened from ${address}`);
    this.#flush();
    return true;
  }

  rejected(address: string): void {
    this.#log('info', `Connection rejected from ${address}: a client is already connected`);
    this.#flush();
  }

  close(reason: string): void {
    if (!this.#session) return;
    this.#session = null;
    const partial = this.#parser.pending;
    if (partial > 0) {
      this.#parser.clear();
      this.#log('info', `Connection closed (${reason}) with ${partial} bytes of an incomplete command: discarded`);
    } else {
      this.#log('info', `Connection closed (${reason})`);
    }
    this.#scanner = new RealtimeScanner();
    this.#flush();
  }

  receive(chunk: Uint8Array): void {
    this.#log('rx', `${chunk.length} bytes received`, chunk);
    let start = 0;
    for (const command of this.#scanner.scan(chunk)) {
      if (this.#realtime(command)) {
        // DLE DC4 fn=8 cleared the buffers: keep only what came after it
        start = command.end;
      }
    }
    this.#parser.push(chunk.subarray(start));
    this.#tokenize();
    this.#run();
    this.#flush();
  }

  // ---- panel controls ----

  setFaults(patch: Partial<Record<PrinterFault, boolean>>): void {
    const before = this.#statusState();
    for (const fault of PRINTER_FAULTS) if (typeof patch[fault] === 'boolean') this.#faults[fault] = patch[fault];
    this.#statusChanged(before);
    this.#run();
    this.#flush();
  }

  /** The cashier closes the drawer (or opens it with the key). */
  setDrawer(open: boolean): void {
    if (open === this.#drawerOpen) return;
    const before = this.#statusState();
    this.#drawerOpen = open;
    this.#statusChanged(before);
    this.#log('info', open ? 'Drawer opened with key' : 'Drawer closed by hand');
    this.#flush();
  }

  setNetwork(listening: boolean, listenError: string | null = null): void {
    this.#network = { listening, listenError };
    this.#flush();
  }

  /** Remove the printed paper by hand (no cut command): archived as a torn ticket. */
  tearOff(): void {
    this.#archive('torn');
    this.#flush();
  }

  /** FEED button: feeds paper while pressed. Offline during the feed, as on the printer. */
  feedButton(dots = 120): void {
    if (!this.online) return;
    const before = this.#statusState();
    this.#feeding = true;
    this.#statusChanged(before);
    this.#currentPaper().feed(dots);
    this.#feeding = false;
    this.#statusChanged({ ...before, feeding: true });
    this.#log('info', 'FEED button: paper feed');
    this.#flush();
  }

  /** Prints `data` as if it came from the host. Refused while a POS stream is half-processed. */
  selfTest(data: Uint8Array): boolean {
    if (this.#pendingBytes() > 0) return false;
    this.#log('info', 'Test receipt');
    this.#parser.push(data);
    this.#tokenize();
    this.#run();
    this.#flush();
    return true;
  }

  /** Paper width changes take effect on restart: the engine is rebuilt, the paper in the printer is archived. */
  applyConfig(config: PrinterConfig): void {
    const widthChanged = config.paperWidth !== this.config.paperWidth;
    if (widthChanged) this.#archive('power-off');
    this.config = config;
    if (widthChanged) this.#engine = this.#newEngine();
    this.#emit({ type: 'printer.config', config });
    this.#flush();
  }

  /** Lab shutdown: keep the partial ticket instead of losing it. */
  shutdown(): void {
    this.#archive('power-off');
    this.#flush();
  }

  // ---- pipeline ----

  #pendingBytes(): number {
    return this.#parser.pending + this.#queuedBytes;
  }

  #tokenize(): void {
    for (let token = this.#parser.next(); token; token = this.#parser.next()) {
      if (token.kind === 'oversized') {
        this.#log('command', `${token.name}: declared length ${token.declared} bytes exceeds the limit; data discarded`, undefined, 'unsupported');
        continue;
      }
      this.#queue.push(token);
      this.#queuedBytes += token.bytes.length;
    }
  }

  #run(): void {
    while (this.online && this.#queue.length) {
      const token = this.#queue.shift()!;
      this.#queuedBytes -= 'bytes' in token ? token.bytes.length : 0;
      this.#execute(token);
    }
  }

  #execute(token: Token): void {
    if (token.kind === 'text') {
      this.#engine.execute(token);
      this.#log('command', `Text "${decode(token.bytes, this.#engine.modes.codePage)}"`, token.bytes, 'supported');
      return;
    }
    if (token.kind !== 'command') {
      this.#log('command', `Unknown ${token.kind === 'unknown' ? token.name : ''}`, token.kind === 'unknown' ? token.bytes : undefined, 'unknown');
      return;
    }
    const support = this.#device(token) ?? this.#engine.execute(token);
    this.#log('command', `${token.name} · ${token.spec.description}`, token.bytes, support);
  }

  /** Commands handled by the device rather than the print engine. Undefined = not a device command. */
  #device(token: Extract<Token, { kind: 'command' }>): Support | undefined {
    const b = token.bytes;
    switch (token.name) {
      case 'DLE EOT': case 'DLE ENQ': case 'DLE DC4':
        return 'supported'; // already acted on when received
      case 'GS r': return this.#reply(gsR(b[2], this.#statusState()));
      case 'GS I': return this.#reply(gsI(b[2]));
      case 'GS a': {
        this.#asbMask = b[2];
        if (this.#asbMask) this.#transmit(asb(this.#statusState()));
        return 'supported';
      }
      case 'ESC @':
        this.#asbMask = 0;
        this.#pulseEnabled = true;
        return undefined; // the engine resets print modes
      case 'GS ( D': {
        // GS ( D pL pH m [a b]...: a=1 drawer pulse, a=2 power-off (not emulated)
        for (let i = 6; i + 1 < b.length; i += 2) if (b[i] === 1) this.#pulseEnabled = b[i + 1] === 1;
        return 'supported';
      }
      case 'ESC p':
        this.#kick(b[2] & 1 ? 5 : 2, `${b[3] * 2} ms`);
        return 'supported';
      default:
        return undefined;
    }
  }

  /** Acts on a real-time command. Returns true if the buffers were cleared. */
  #realtime(command: RealtimeCommand): boolean {
    const [, , n] = command.bytes;
    this.#log('command', `${command.name} (real time)`, command.bytes, command.name === 'DLE ENQ' ? 'ignored' : 'supported');
    if (command.name === 'DLE EOT') this.#transmit(dleEot(n, this.#statusState())!);
    if (command.name === 'DLE DC4' && n === 1 && this.#pulseEnabled) this.#kick(command.bytes[3] ? 5 : 2, `${command.bytes[4] * 100} ms, real time`);
    if (command.name === 'DLE DC4' && n === 8) {
      this.#parser.clear();
      this.#queue = [];
      this.#queuedBytes = 0;
      this.#engine = this.#newEngine(this.#engine);
      this.#transmit(Uint8Array.of(0x37, 0x25, 0x00));
      return true;
    }
    return false;
  }

  /** Drawer kick-out pulse. The drawer hangs on pin 2; pin 5 is the second drawer, not connected. */
  #kick(pin: 2 | 5, length: string): void {
    if (pin === 5) return this.#log('info', `Drawer pulse on pin 5 (${length}): no second drawer connected`);
    if (this.#drawerOpen) return this.#log('info', `Drawer pulse on pin 2 (${length}): drawer already open`);
    const before = this.#statusState();
    this.#drawerOpen = true;
    this.#statusChanged(before);
    this.#log('info', `Drawer pulse on pin 2 (${length}): drawer opened`);
  }

  #reply(bytes: Uint8Array | undefined): Support {
    if (!bytes) return 'ignored';
    this.#transmit(bytes);
    return 'supported';
  }

  #transmit(bytes: Uint8Array): void {
    if (!this.#session) return;
    this.#session.transmit(bytes);
    this.#log('tx', `${bytes.length} bytes sent`, bytes);
  }

  // ---- status ----

  #statusState(): StatusState {
    // Drawer open = pin 3 HIGH (most drawers); some switch the other way, add a config option if a POS needs it
    return { faults: { ...this.#faults }, drawerPin3: this.#drawerOpen, feeding: this.#feeding };
  }

  /** ASB on any change in an enabled category (drawer 0x01, online 0x02, error 0x04, paper 0x08, panel 0x40). */
  #statusChanged(before: StatusState): void {
    const after = this.#statusState();
    const categories = (s: StatusState) => [
      [0x01, s.drawerPin3],
      [0x02, isOffline(s)],
      [0x04, s.faults.headOverheat],
      [0x08, `${s.faults.paperNearEnd}${s.faults.paperOut}`],
      [0x40, s.feeding],
    ] as const;
    const was = categories(before);
    const changed = categories(after).some(([bit, v], i) => this.#asbMask & bit && v !== was[i][1]);
    if (changed) this.#transmit(asb(after));
  }

  // ---- paper ----

  #newEngine(previous?: PrintEngine): PrintEngine {
    const engine = new PrintEngine(this.widthDots, {
      paper: () => this.#currentPaper(),
      cut: () => this.#archive('cut'),
      transmit: (bytes) => this.#transmit(bytes),
    });
    if (previous && previous.width === engine.width) engine.modes = previous.modes;
    return engine;
  }

  #currentPaper(): Bitmap {
    if (!this.#paper) {
      const startedAt = new Date().toISOString();
      const id = `${startedAt.replace(/[-:.]/g, '')}-${String(++this.#ticketSeq).padStart(4, '0')}`;
      this.#paper = {
        bitmap: new Bitmap(this.widthDots),
        info: { id, printerId: this.config.id, startedAt, endedAt: null, end: null, widthDots: this.widthDots, heightDots: 0, truncated: false },
      };
    }
    return this.#paper.bitmap;
  }

  #paperInfo(): TicketInfo | null {
    if (!this.#paper) return null;
    const { bitmap, info } = this.#paper;
    return { ...info, heightDots: bitmap.height, truncated: bitmap.truncated };
  }

  #archive(end: TicketEnd): void {
    const info = this.#paperInfo();
    const bitmap = this.#paper?.bitmap;
    this.#paper = null;
    if (!info || !bitmap || bitmap.height === 0) return;
    const ticket: TicketInfo = { ...info, endedAt: new Date().toISOString(), end };
    this.#sink.saveTicket(ticket, bitmap.toPng());
    this.#log('info', `Ticket ${end === 'cut' ? 'cut' : end === 'torn' ? 'torn off by hand' : 'archived on power off'} (${bitmap.height} dots)`);
    this.#emit({ type: 'printer.ticket', ticket });
    this.#lastPaperHeight = -1; // force a paper event
  }

  // ---- events ----

  #log(kind: InspectorEntry['kind'], label: string, bytes?: Uint8Array, support?: Support): void {
    const entry: InspectorEntry = { seq: ++this.#inspectorSeq, at: new Date().toISOString(), kind, label, hex: hexPreview(bytes) };
    if (support) entry.support = support;
    this.#inspector.push(entry);
    if (this.#inspector.length > INSPECTOR_SIZE) this.#inspector.splice(0, this.#inspector.length - INSPECTOR_SIZE);
    this.#newEntries.push(entry);
  }

  #flush(): void {
    const status = JSON.stringify(this.status());
    if (status !== this.#lastStatus) {
      this.#lastStatus = status;
      this.#emit({ type: 'printer.status', status: this.status() });
    }
    if (this.paperHeight !== this.#lastPaperHeight) {
      this.#lastPaperHeight = this.paperHeight;
      this.#emit({ type: 'printer.paper', paper: this.#paperInfo() });
    }
    if (this.#newEntries.length) {
      this.#emit({ type: 'printer.inspector', entries: this.#newEntries.slice(-INSPECTOR_SIZE) });
      this.#newEntries = [];
    }
  }
}

function hexPreview(bytes: Uint8Array | undefined): string {
  if (!bytes?.length) return '';
  const shown = Buffer.from(bytes.subarray(0, HEX_PREVIEW)).toString('hex').replace(/(..)(?!$)/g, '$1 ');
  return bytes.length > HEX_PREVIEW ? `${shown} … (+${bytes.length - HEX_PREVIEW})` : shown;
}

function decode(bytes: Uint8Array, codePage: number): string {
  const high = (CODE_PAGES[codePage] ?? CODE_PAGES[0]).high;
  return Array.from(bytes, (b) => (b < 0x80 ? String.fromCharCode(b) : high[b - 0x80])).join('');
}
