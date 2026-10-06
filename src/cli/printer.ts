import { connect, type Socket } from 'node:net';
import { once } from 'node:events';
import { CODE_PAGES } from '../server/printer/escpos/codepages.ts';

// The CLI behaves like a POS: raw ESC/POS over TCP, nothing lab-specific.

const ESC = 0x1b, GS = 0x1d, DLE = 0x10, LF = 0x0a;

const STATUS_BITS: Record<number, [number, string][]> = {
  1: [[0x04, 'drawer open (pin 3 high)'], [0x08, 'offline']],
  2: [[0x04, 'cover open'], [0x08, 'feeding paper with FEED'], [0x20, 'stopped: paper out'], [0x40, 'error']],
  3: [[0x08, 'cutter error'], [0x20, 'unrecoverable error'], [0x40, 'automatically recoverable error']],
  4: [[0x0c, 'paper near end'], [0x60, 'paper out']],
};

/** Meaning of a DLE EOT n reply (empty = all clear). */
export function decodeStatus(n: number, byte: number): string[] {
  return (STATUS_BITS[n] ?? []).filter(([mask]) => (byte & mask) === mask).map(([, label]) => label);
}

const PC858 = CODE_PAGES[19].high;

/** Text in PC858 (ESC t 19): ASCII plus € and Spanish characters; anything else becomes '?'. */
export function encodeText(text: string): Uint8Array {
  return Uint8Array.from([...text], (ch) => {
    const code = ch.codePointAt(0)!;
    if (code < 0x80) return code;
    const i = PC858.indexOf(ch);
    return i >= 0 ? 0x80 + i : 0x3f;
  });
}

export function textTicket(lines: string[], cut: boolean): Uint8Array {
  const parts: number[] = [ESC, 0x40, ESC, 0x74, 19];
  for (const line of lines) parts.push(...encodeText(line), LF);
  if (cut) parts.push(ESC, 0x64, 4, GS, 0x56, 1);
  return Uint8Array.from(parts);
}

/** A TCP session with the printer that collects whatever it sends back. */
export class PrinterClient {
  readonly socket: Socket;
  #received: number[] = [];
  #waiters: (() => void)[] = [];

  private constructor(socket: Socket) {
    this.socket = socket;
    socket.on('data', (d) => {
      this.#received.push(...d);
      for (const w of this.#waiters.splice(0)) w();
    });
  }

  static async open(host: string, port: number, timeoutMs: number): Promise<PrinterClient> {
    const socket = connect({ host, port, timeout: timeoutMs });
    try {
      await Promise.race([
        once(socket, 'connect'),
        once(socket, 'timeout').then(() => {
          throw new Error('timeout');
        }),
      ]);
    } catch (error) {
      socket.destroy();
      throw new Error(`Cannot connect to the printer at ${host}:${port} (${(error as Error).message})`);
    }
    socket.setTimeout(0);
    return new PrinterClient(socket);
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (!this.socket.write(bytes)) await once(this.socket, 'drain');
  }

  /** Waits until the received bytes satisfy `ready` or the timeout expires. */
  async #until(ready: (received: number[]) => boolean, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (!ready(this.#received)) {
      const left = deadline - Date.now();
      if (left <= 0) return false;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.#waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    return true;
  }

  /** Takes up to `count` reply bytes, waiting for them until the timeout. */
  async read(count: number, timeoutMs: number): Promise<number[]> {
    await this.#until((r) => r.length >= count, timeoutMs);
    return this.#received.splice(0, count);
  }

  /** Reads a GS I "_<text>NUL" block, if it arrives in time. */
  async readInfo(timeoutMs: number): Promise<string | null> {
    const complete = (r: number[]) => r[0] === 0x5f && r.indexOf(0) > 0;
    if (!(await this.#until(complete, timeoutMs))) return null;
    const block = this.#received.splice(0, this.#received.indexOf(0) + 1);
    return Buffer.from(block.slice(1, -1)).toString('latin1');
  }

  async close(): Promise<void> {
    this.socket.end();
    await once(this.socket, 'close').catch(() => undefined);
  }

  static readonly DLE_EOT = (n: number) => Uint8Array.of(DLE, 0x04, n);
  static readonly GS_I = (n: number) => Uint8Array.of(GS, 0x49, n);
}
