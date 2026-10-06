import { crc32, deflateSync } from 'node:zlib';

/** Growable 1-bit raster, one row per printed dot line. Bits are packed MSB-first; 1 = burnt dot. */
export class Bitmap {
  readonly width: number;
  readonly maxHeight: number;
  readonly bytesPerRow: number;
  height = 0;
  truncated = false;
  #data: Uint8Array;

  constructor(width: number, maxHeight = 40_000) {
    this.width = width;
    this.maxHeight = maxHeight;
    this.bytesPerRow = Math.ceil(width / 8);
    this.#data = new Uint8Array(this.bytesPerRow * 256);
  }

  /** Makes sure `rows` rows exist, up to `maxHeight` (beyond it the bitmap is marked truncated). */
  ensure(rows: number): void {
    if (rows > this.maxHeight) {
      this.truncated = true;
      rows = this.maxHeight;
    }
    if (rows <= this.height) return;
    const needed = rows * this.bytesPerRow;
    if (needed > this.#data.length) {
      const grown = new Uint8Array(Math.max(needed, this.#data.length * 2));
      grown.set(this.#data);
      this.#data = grown;
    }
    this.height = rows;
  }

  feed(rows: number): void {
    this.ensure(this.height + rows);
  }

  set(x: number, y: number): void {
    if (x < 0 || x >= this.width || y < 0) return;
    if (y >= this.height) this.ensure(y + 1);
    if (y >= this.height) return;
    this.#data[y * this.bytesPerRow + (x >> 3)] |= 0x80 >> (x & 7);
  }

  get(x: number, y: number): boolean {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return false;
    return (this.#data[y * this.bytesPerRow + (x >> 3)] & (0x80 >> (x & 7))) !== 0;
  }

  /** Grayscale 1-bit PNG (PNG gray 0 = black, so bits are inverted). */
  toPng(): Buffer {
    const rows = Math.max(this.height, 1);
    const raw = Buffer.alloc(rows * (this.bytesPerRow + 1), 0xff);
    for (let y = 0; y < rows; y++) {
      const o = y * (this.bytesPerRow + 1);
      raw[o] = 0; // filter: none
      for (let i = 0; i < this.bytesPerRow; i++) {
        raw[o + 1 + i] = y < this.height ? ~this.#data[y * this.bytesPerRow + i] & 0xff : 0xff;
      }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(this.width, 0);
    ihdr.writeUInt32BE(rows, 4);
    ihdr.set([1, 0, 0, 0, 0], 8); // bit depth 1, grayscale, deflate, no filter, no interlace
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]);
  }
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}
