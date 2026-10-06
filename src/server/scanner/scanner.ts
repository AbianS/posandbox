import type { ScannerConfig, ScannerEvent, ScannerSnapshot, ScannerStatus, ScanResult } from '../../shared/contract.ts';
import { dispatchKeys, keyEvents, listTargets, pickTarget, type CdpTarget } from './cdp.ts';

const HISTORY = 50;
/**
 * From trigger to typing: bringing the item to the window and decoding it. The 3D bench animates the same
 * span, so the code reaches the POS when the beep sounds.
 */
const DECODE_MS = 650;

/**
 * Virtual USB barcode scanner in keyboard-wedge mode. A real one types into whatever window has the focus;
 * this one types into the POS window it finds through the POS's DevTools port, so it needs no focus and no
 * agent on the POS machine. One scan at a time, like a scanner's single trigger.
 */
export class Scanner {
  config: ScannerConfig;
  readonly #emit: (event: ScannerEvent) => void;
  #status: ScannerStatus = { link: null, scanning: null };
  #scans: ScanResult[] = [];
  #seq = 0;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(config: ScannerConfig, emit: (event: ScannerEvent) => void) {
    this.config = config;
    this.#emit = emit;
  }

  snapshot(): ScannerSnapshot {
    return { config: this.config, status: { ...this.#status }, scans: [...this.#scans] };
  }

  applyConfig(config: ScannerConfig): void {
    this.config = config;
    this.#emit({ type: 'scanner.config', config });
    this.#setStatus({ link: null });
  }

  /** Looks for the POS window without typing anything. */
  async probe(): Promise<ScannerStatus['link']> {
    try {
      const target = await this.#target();
      this.#setStatus({ link: { ok: true, detail: `Ventana «${target.title || target.url}»` } });
    } catch (error) {
      this.#setStatus({ link: { ok: false, detail: (error as Error).message } });
    }
    return this.#status.link;
  }

  /** Pulls the trigger on `data`: types it, plus the suffix, into the POS window. */
  scan(data: string): Promise<ScanResult> {
    const run = this.#queue.then(() => this.#scan(data));
    this.#queue = run.catch(() => {});
    return run;
  }

  async #scan(data: string): Promise<ScanResult> {
    if (!this.config.enabled) return this.#result(data, false, 'Scanner disconnected: the trigger does nothing');
    this.#setStatus({ scanning: data });
    try {
      await new Promise((r) => setTimeout(r, DECODE_MS));
      const target = await this.#target();
      await dispatchKeys(this.config.cdpHost, this.config.cdpPort, target, keyEvents(data, this.config.suffix), this.config.keyDelay);
      this.#setStatus({ link: { ok: true, detail: `Ventana «${target.title || target.url}»` } });
      return this.#result(data, true, `Typed into «${target.title || target.url}»${this.config.suffix === 'none' ? '' : ` + ${this.config.suffix}`}`);
    } catch (error) {
      const detail = (error as Error).message;
      this.#setStatus({ link: { ok: false, detail } });
      return this.#result(data, false, detail);
    } finally {
      this.#setStatus({ scanning: null });
    }
  }

  async #target(): Promise<CdpTarget> {
    const { cdpHost: host, cdpPort: port, target: match } = this.config;
    let targets: CdpTarget[];
    try {
      targets = await listTargets(host, port);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EHOSTUNREACH') {
        throw new Error(`No POS with DevTools at ${host}:${port}. Start Electron with --remote-debugging-port=${port}`);
      }
      throw error;
    }
    const target = pickTarget(targets, match);
    if (!target) throw new Error(match ? `No POS window contains “${match}” in its title or URL` : 'The POS has no open windows');
    return target;
  }

  #result(data: string, delivered: boolean, detail: string): ScanResult {
    const scan: ScanResult = { seq: ++this.#seq, at: new Date().toISOString(), data, delivered, detail };
    this.#scans = [scan, ...this.#scans].slice(0, HISTORY);
    this.#emit({ type: 'scanner.scan', scan });
    return scan;
  }

  #setStatus(patch: Partial<ScannerStatus>): void {
    const next = { ...this.#status, ...patch };
    if (JSON.stringify(next) === JSON.stringify(this.#status)) return;
    this.#status = next;
    this.#emit({ type: 'scanner.status', status: { ...next } });
  }
}
