import { join } from 'node:path';
import type { LabEvent, LabSnapshot, PrinterConfig, PrinterConfigPatch, PrinterEvent, PrinterFault, ScannerConfig, ScannerConfigPatch, ScannerEvent, TerminalConfig, TerminalConfigPatch, TerminalEvent } from '../shared/contract.ts';
import { Scanner } from './scanner/scanner.ts';
import { Printer } from './printer/printer.ts';
import { TcpListener } from './printer/tcp.ts';
import { NexoListener } from './terminal/https.ts';
import { Terminal, type TerminalState, type Timing } from './terminal/terminal.ts';
import { loadPki, type TerminalPki } from './terminal/x509.ts';
import type { LabConfig, Store } from './store.ts';

interface PrinterUnit {
  printer: Printer;
  listener: TcpListener;
}

interface TerminalUnit {
  terminal: Terminal;
  listener: NexoListener;
  pki: TerminalPki | null;
}

/**
 * The lab: the set of virtual devices, their network listeners and one ordered event stream.
 * Every event gets a lab-wide sequence number and the id of its device; the panel uses the
 * sequence to detect gaps and refetch the snapshot.
 */
export class Lab {
  readonly store: Store;
  readonly host: string;
  #config: LabConfig;
  #units = new Map<string, PrinterUnit>();
  #terminals = new Map<string, TerminalUnit>();
  #scanners = new Map<string, Scanner>();
  #seq = 0;
  #subscribers = new Set<(event: LabEvent) => void>();
  readonly #timing?: Timing;

  constructor(store: Store, config: LabConfig, host: string, timing?: Timing) {
    this.store = store;
    this.#config = config;
    this.host = host;
    this.#timing = timing;
  }

  async start(): Promise<void> {
    for (const config of this.#config.printers) {
      const printer = new Printer(config, this.store, (event) => this.#emit(config.id, event));
      const unit = { printer, listener: new TcpListener(printer) };
      this.#units.set(config.id, unit);
      if (config.enabled) await this.#powerOn(unit);
    }
    for (const config of this.#config.terminals) {
      const terminal = new Terminal(config, (event) => this.#emit(config.id, event), this.#timing, {
        load: () => this.store.loadTerminalState<TerminalState>(config.id),
        save: (state) => this.store.saveTerminalState(config.id, state),
      });
      const unit = { terminal, listener: new NexoListener((body, peer) => terminal.handle(body, peer)), pki: null };
      this.#terminals.set(config.id, unit);
      if (config.enabled) await this.#powerOnTerminal(unit);
    }
    for (const config of this.#config.scanners) this.#scanners.set(config.id, new Scanner(config, (event) => this.#emit(config.id, event)));
  }

  async stop(): Promise<void> {
    for (const unit of this.#units.values()) {
      await unit.listener.close('lab stopped');
      unit.printer.shutdown();
    }
    for (const unit of this.#terminals.values()) await unit.listener.close();
  }

  snapshot(): LabSnapshot {
    return {
      seq: this.#seq,
      printers: [...this.#units.values()].map(({ printer }) => printer.snapshot(this.store.listTickets(printer.config.id))),
      terminals: [...this.#terminals.values()].map(({ terminal }) => terminal.snapshot()),
      scanners: [...this.#scanners.values()].map((s) => s.snapshot()),
    };
  }

  subscribe(fn: (event: LabEvent) => void): () => void {
    this.#subscribers.add(fn);
    return () => this.#subscribers.delete(fn);
  }

  printer(id: string): Printer | undefined {
    return this.#units.get(id)?.printer;
  }

  /** Bound TCP port (differs from the config when it is 0 = any free port). */
  printerPort(id: string): number | null {
    return this.#units.get(id)?.listener.port ?? null;
  }

  setFaults(id: string, patch: Partial<Record<PrinterFault, boolean>>): void {
    this.#unit(id).printer.setFaults(patch);
  }

  /** Deletes archived tickets (all of them when `ids` is omitted). */
  deleteTickets(id: string, ids?: string[]): string[] {
    this.#unit(id);
    const deleted = this.store.deleteTickets(id, ids);
    if (deleted.length) this.#emit(id, { type: 'printer.tickets-deleted', ids: deleted });
    return deleted;
  }

  disconnect(id: string): void {
    this.#unit(id).listener.disconnect('disconnected from panel');
  }

  /** Applies and persists a config change. Port and power changes restart the listener. */
  async updateConfig(id: string, patch: PrinterConfigPatch): Promise<PrinterConfig> {
    const unit = this.#unit(id);
    const before = unit.printer.config;
    const config: PrinterConfig = { ...before, ...patch };
    this.#config = { ...this.#config, printers: this.#config.printers.map((p) => (p.id === id ? config : p)) };
    this.store.saveConfig(this.#config);

    const restart = config.port !== before.port || config.enabled !== before.enabled;
    if (restart) await unit.listener.close('virtual printer restart');
    unit.printer.applyConfig(config);
    if (restart && config.enabled) await this.#powerOn(unit);
    if (restart && !config.enabled) unit.printer.setNetwork(false);
    return config;
  }

  async #powerOn({ printer, listener }: PrinterUnit): Promise<void> {
    try {
      await listener.listen(printer.config.port, this.host);
      printer.setNetwork(true);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const port = printer.config.port;
      printer.setNetwork(false, code === 'EADDRINUSE' ? `Port ${port} is already in use` : `Could not open port ${port}: ${code}`);
    }
  }

  // ---- payment terminals ----

  terminal(id: string): Terminal | undefined {
    return this.#terminals.get(id)?.terminal;
  }

  terminalPort(id: string): number | null {
    return this.#terminals.get(id)?.listener.port ?? null;
  }

  /** The CA the POS must trust to accept this terminal's certificate. */
  terminalCa(id: string): string | null {
    const unit = this.#terminals.get(id);
    return unit ? (unit.pki ?? loadPki(join(this.store.dir, 'pki'), id, unit.terminal.config.poiid)).caPem : null;
  }

  /** Port, power and POIID (the certificate's name) changes restart the terminal. */
  async updateTerminalConfig(id: string, patch: TerminalConfigPatch): Promise<TerminalConfig> {
    const unit = this.#terminals.get(id);
    if (!unit) throw new NotFound(`terminal ${id}`);
    const before = unit.terminal.config;
    const config: TerminalConfig = { ...before, ...patch };
    this.#config = { ...this.#config, terminals: this.#config.terminals.map((t) => (t.id === id ? config : t)) };
    this.store.saveConfig(this.#config);
    const restart = config.port !== before.port || config.enabled !== before.enabled || config.poiid !== before.poiid;
    if (restart) {
      await unit.listener.close();
      unit.terminal.setNetwork(false);
    }
    unit.terminal.applyConfig(config);
    if (restart && config.enabled) await this.#powerOnTerminal(unit);
    return config;
  }

  async #powerOnTerminal(unit: TerminalUnit): Promise<void> {
    const { terminal, listener } = unit;
    const { id, poiid, port } = terminal.config;
    try {
      unit.pki = loadPki(join(this.store.dir, 'pki'), id, poiid);
      await listener.listen(port, this.host, { key: unit.pki.keyPem, cert: unit.pki.certPem });
      terminal.setNetwork(true);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      terminal.setNetwork(false, code === 'EADDRINUSE' ? `Port ${port} is already in use` : `Could not start terminal: ${code ?? (error as Error).message}`);
    }
  }

  // ---- barcode scanners ----

  scanner(id: string): Scanner | undefined {
    return this.#scanners.get(id);
  }

  updateScannerConfig(id: string, patch: ScannerConfigPatch): ScannerConfig {
    const scanner = this.#scanners.get(id);
    if (!scanner) throw new NotFound(`scanner ${id}`);
    const config: ScannerConfig = { ...scanner.config, ...patch };
    this.#config = { ...this.#config, scanners: this.#config.scanners.map((s) => (s.id === id ? config : s)) };
    this.store.saveConfig(this.#config);
    scanner.applyConfig(config);
    return config;
  }

  #unit(id: string): PrinterUnit {
    const unit = this.#units.get(id);
    if (!unit) throw new NotFound(`printer ${id}`);
    return unit;
  }

  #emit(deviceId: string, event: PrinterEvent | TerminalEvent | ScannerEvent): void {
    this.#publish({ ...event, seq: ++this.#seq, deviceId });
  }

  #publish(event: LabEvent): void {
    for (const fn of this.#subscribers) fn(event);
  }
}

export class NotFound extends Error {}
