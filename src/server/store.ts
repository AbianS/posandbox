import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PrinterConfig, ScannerConfig, TerminalConfig, TicketInfo } from '../shared/contract.ts';

export interface LabConfig {
  printers: PrinterConfig[];
  terminals: TerminalConfig[];
  scanners: ScannerConfig[];
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Files on disk: `config.json` and `tickets/<printerId>/<ticketId>.{json,png}`. Writes are atomic (tmp + rename). */
export class Store {
  readonly dir: string;
  readonly maxTickets: number;

  constructor(dir: string, maxTickets = 200) {
    this.dir = dir;
    this.maxTickets = maxTickets;
  }

  loadConfig(defaults: LabConfig): LabConfig {
    try {
      // devices added in later versions get their defaults
      const config = { ...defaults, ...(JSON.parse(readFileSync(join(this.dir, 'config.json'), 'utf8')) as Partial<LabConfig>) };
      const names: Record<string, string> = { 'Impresora de tickets': 'Receipt printer', 'Datáfono': 'Payment terminal', 'Escáner': 'Scanner' };
      for (const device of [...config.printers, ...config.terminals, ...config.scanners]) {
        if (Object.hasOwn(names, device.name)) device.name = names[device.name];
      }
      return config;
    } catch {
      return defaults;
    }
  }

  /** A payment terminal's transaction record (`terminals/<id>.json`). */
  loadTerminalState<T>(terminalId: string): T | null {
    if (!SAFE_ID.test(terminalId)) return null;
    try {
      return JSON.parse(readFileSync(join(this.dir, 'terminals', `${terminalId}.json`), 'utf8')) as T;
    } catch {
      return null;
    }
  }

  saveTerminalState(terminalId: string, state: unknown): void {
    if (SAFE_ID.test(terminalId)) this.#write(join(this.dir, 'terminals', `${terminalId}.json`), JSON.stringify(state));
  }

  saveConfig(config: LabConfig): void {
    this.#write(join(this.dir, 'config.json'), JSON.stringify(config, null, 2));
  }

  saveTicket(ticket: TicketInfo, png: Buffer): void {
    const dir = this.#ticketDir(ticket.printerId);
    if (!dir || !SAFE_ID.test(ticket.id)) throw new Error(`invalid ticket id ${ticket.id}`);
    this.#write(join(dir, `${ticket.id}.png`), png);
    this.#write(join(dir, `${ticket.id}.json`), JSON.stringify(ticket));
    for (const old of this.#ids(dir).slice(0, -this.maxTickets)) {
      rmSync(join(dir, `${old}.json`), { force: true });
      rmSync(join(dir, `${old}.png`), { force: true });
    }
  }

  /** Newest first. */
  listTickets(printerId: string): TicketInfo[] {
    const dir = this.#ticketDir(printerId);
    if (!dir) return [];
    return this.#ids(dir)
      .reverse()
      .map((id) => JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8')) as TicketInfo);
  }

  readTicketImage(printerId: string, ticketId: string): Buffer | undefined {
    const dir = this.#ticketDir(printerId);
    if (!dir || !SAFE_ID.test(ticketId)) return undefined;
    try {
      return readFileSync(join(dir, `${ticketId}.png`));
    } catch {
      return undefined;
    }
  }

  /** Deletes the given tickets (all of them when `ids` is omitted). Returns the ids actually deleted. */
  deleteTickets(printerId: string, ids?: string[]): string[] {
    const dir = this.#ticketDir(printerId);
    if (!dir) return [];
    const existing = new Set(this.#ids(dir));
    const doomed = (ids ?? [...existing]).filter((id) => SAFE_ID.test(id) && existing.has(id));
    for (const id of doomed) {
      rmSync(join(dir, `${id}.json`), { force: true });
      rmSync(join(dir, `${id}.png`), { force: true });
    }
    return doomed;
  }

  #ticketDir(printerId: string): string | undefined {
    return SAFE_ID.test(printerId) ? join(this.dir, 'tickets', printerId) : undefined;
  }

  /** Ticket ids sorted oldest first (ids are time-ordered, saves are in order). */
  #ids(dir: string): string[] {
    try {
      return readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.slice(0, -5))
        .sort();
    } catch {
      return [];
    }
  }

  #write(file: string, data: string | Buffer): void {
    mkdirSync(join(file, '..'), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, data);
    renameSync(tmp, file);
  }
}
