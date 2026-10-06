const DLE = 0x10, EOT = 0x04, ENQ = 0x05, DC4 = 0x14;

export interface RealtimeCommand {
  name: 'DLE EOT' | 'DLE ENQ' | 'DLE DC4';
  bytes: Uint8Array;
  /** Offset in the scanned chunk right after the command. */
  end: number;
}

/**
 * Real-time commands are recognised as bytes arrive, before normal command processing and wherever
 * they appear — Epson: "If parameter of a normal command contains the data string that is the same as
 * a Real-time command, the data will be also processed as the Real-time command."
 * The same bytes still go to the receive buffer, where the normal parser consumes them.
 */
export class RealtimeScanner {
  #tail = new Uint8Array(0);

  scan(chunk: Uint8Array): RealtimeCommand[] {
    const carried = this.#tail.length;
    const b = new Uint8Array(carried + chunk.length);
    b.set(this.#tail);
    b.set(chunk, this.#tail.length);
    this.#tail = new Uint8Array(0);

    const found: RealtimeCommand[] = [];
    for (let i = 0; i < b.length; i++) {
      if (b[i] !== DLE) continue;
      const length = match(b, i);
      if (length === undefined) {
        this.#tail = b.slice(i);
        break;
      }
      if (length > 0) {
        found.push({ name: NAMES[b[i + 1]], bytes: b.slice(i, i + length), end: i + length - carried });
        i += length - 1;
      }
    }
    return found;
  }
}

const NAMES: Record<number, RealtimeCommand['name']> = { [EOT]: 'DLE EOT', [ENQ]: 'DLE ENQ', [DC4]: 'DLE DC4' };
const POWER_OFF = [2, 1, 8];
const CLEAR_BUFFERS = [8, 1, 3, 20, 1, 6, 2, 8];

/** Command length at b[i] (a DLE), 0 if it is not a valid TM-T20III real-time command, undefined if incomplete. */
function match(b: Uint8Array, i: number): number | undefined {
  const at = (k: number) => (i + k < b.length ? b[i + k] : undefined);
  const cmd = at(1);
  if (cmd === undefined) return undefined;
  if (cmd === EOT || cmd === ENQ) {
    const n = at(2);
    if (n === undefined) return undefined;
    return (cmd === EOT ? n >= 1 && n <= 4 : n === 1 || n === 2) ? 3 : 0;
  }
  if (cmd !== DC4) return 0;
  const fn = at(2);
  if (fn === undefined) return undefined;
  if (fn === 1) {
    const [m, t] = [at(3), at(4)];
    if (m === undefined || t === undefined) return undefined;
    return (m === 0 || m === 1) && t >= 1 && t <= 8 ? 5 : 0;
  }
  const expected = fn === 2 ? POWER_OFF : fn === 8 ? CLEAR_BUFFERS : undefined;
  if (!expected) return 0;
  for (let k = 0; k < expected.length; k++) {
    const v = at(2 + k);
    if (v === undefined) return undefined;
    if (v !== expected[k]) return 0;
  }
  return 2 + expected.length;
}
