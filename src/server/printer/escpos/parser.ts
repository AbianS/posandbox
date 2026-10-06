import { lookup, type CommandSpec } from './commands.ts';

export type Token =
  | { kind: 'text'; bytes: Uint8Array }
  | { kind: 'command'; name: string; spec: CommandSpec; bytes: Uint8Array }
  | { kind: 'unknown'; name: string; bytes: Uint8Array }
  /** Declared length above the limit: the data is discarded as it arrives, never buffered. */
  | { kind: 'oversized'; name: string; declared: number };

/**
 * Incremental ESC/POS tokenizer over a binary stream. TCP does not keep command boundaries,
 * so bytes are buffered until a whole command is available.
 */
export class Parser {
  readonly maxCommandBytes: number;
  #buf = new Uint8Array(0);
  #pos = 0;
  #skip = 0;

  constructor(options: { maxCommandBytes?: number } = {}) {
    this.maxCommandBytes = options.maxCommandBytes ?? 4 * 1024 * 1024;
  }

  /** Bytes received and not yet consumed as tokens. */
  get pending(): number {
    return this.#buf.length - this.#pos;
  }

  push(chunk: Uint8Array): void {
    if (this.#skip > 0) {
      const dropped = Math.min(this.#skip, chunk.length);
      this.#skip -= dropped;
      chunk = chunk.subarray(dropped);
    }
    if (chunk.length === 0) return;
    const rest = this.#buf.subarray(this.#pos);
    const next = new Uint8Array(rest.length + chunk.length);
    next.set(rest);
    next.set(chunk, rest.length);
    this.#buf = next;
    this.#pos = 0;
  }

  clear(): void {
    this.#buf = new Uint8Array(0);
    this.#pos = 0;
    this.#skip = 0;
  }

  /** Next complete token, or undefined if more bytes are needed. */
  next(): Token | undefined {
    const b = this.#buf;
    const i = this.#pos;
    if (i >= b.length) return undefined;

    if (b[i] >= 0x20) {
      let end = i;
      while (end < b.length && b[end] >= 0x20) end++;
      return this.#take({ kind: 'text', bytes: b.slice(i, end) }, end - i);
    }

    const found = lookup(b, i);
    if (!found) return undefined;
    if ('unknown' in found) {
      if (i + found.length > b.length) return undefined;
      return this.#take({ kind: 'unknown', name: found.unknown, bytes: b.slice(i, i + found.length) }, found.length);
    }
    const { spec } = found;
    const size = spec.size(b, i);
    if (size === undefined) return undefined;
    if (size > this.maxCommandBytes) {
      const available = b.length - i;
      this.#skip = size - available;
      this.#buf = new Uint8Array(0);
      this.#pos = 0;
      return { kind: 'oversized', name: spec.name, declared: size };
    }
    if (i + size > b.length) return undefined;
    return this.#take({ kind: 'command', name: spec.name, spec, bytes: b.slice(i, i + size) }, size);
  }

  #take<T extends Token>(token: T, length: number): T {
    this.#pos += length;
    if (this.#pos === this.#buf.length) {
      this.#buf = new Uint8Array(0);
      this.#pos = 0;
    }
    return token;
  }
}
