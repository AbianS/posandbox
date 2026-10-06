import type { Support } from '../../../shared/contract.ts';

/**
 * ESC/POS command table for the TM-T20III profile.
 * `size` returns the total command length starting at `i`, or undefined while more bytes are needed.
 * Commands we do not emulate are still listed so their parameters are consumed, never printed as text.
 * `support`: supported = emulated; ignored = accepted, no visible effect; unsupported = consumed and reported.
 */
export interface CommandSpec {
  name: string;
  support: Support;
  description: string;
  size: (b: Uint8Array, i: number) => number | undefined;
}

type Size = CommandSpec['size'];

const fixed = (n: number): Size => (b, i) => (b.length - i >= n ? n : undefined);
const u16 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8);
/** `header` bytes, then a little-endian 16-bit length at `at`, then that many data bytes (times `unit`). */
const lengthAt = (header: number, at: number, unit = 1): Size => (b, i) =>
  b.length - i >= at + 2 ? header + u16(b, i + at) * unit : undefined;
/** Data runs until a NUL after `from` bytes. */
const untilNul = (from: number): Size => (b, i) => {
  const end = b.indexOf(0, i + from);
  return end < 0 ? undefined : end - i + 1;
};
const need = (b: Uint8Array, i: number, n: number) => b.length - i >= n;

// ESC * m nL nH d1..dk — k = n (8-dot modes) or 3n (24-dot modes)
const escStar: Size = (b, i) => (need(b, i, 5) ? 5 + u16(b, i + 3) * (b[i + 2] >= 32 ? 3 : 1) : undefined);
// GS v 0 m xL xH yL yH d1..dk — k = x * y
const gsV0: Size = (b, i) => (need(b, i, 8) ? 8 + u16(b, i + 4) * u16(b, i + 6) : undefined);
// GS * x y d1..dk — k = x * y * 8
const gsStar: Size = (b, i) => (need(b, i, 4) ? 4 + b[i + 2] * b[i + 3] * 8 : undefined);
// GS 8 L p1 p2 p3 p4 m fn ... — 32-bit length
const gs8L: Size = (b, i) =>
  need(b, i, 7) ? 7 + (b[i + 3] + b[i + 4] * 0x100 + b[i + 5] * 0x10000 + b[i + 6] * 0x1000000) : undefined;
// GS k m d1..dk NUL (m 0-6) | GS k m n d1..dn (m 65+)
const gsK: Size = (b, i) => {
  if (!need(b, i, 3)) return undefined;
  if (b[i + 2] <= 6) return untilNul(3)(b, i);
  return need(b, i, 4) ? 4 + b[i + 3] : undefined;
};
// GS V m [n]
const gsV: Size = (b, i) => (need(b, i, 3) ? ([65, 66, 97, 98, 103, 104].includes(b[i + 2]) ? fixed(4)(b, i) : 3) : undefined);
// DLE DC4 fn ... — parameter bytes for fn 1, 2, 3, 7, 8 are 2, 2, 5, 1, 7
const dleDc4: Size = (b, i) => {
  if (!need(b, i, 3)) return undefined;
  const params: Record<number, number> = { 1: 2, 2: 2, 3: 5, 7: 1, 8: 7 };
  return fixed(3 + (params[b[i + 2]] ?? 0))(b, i);
};
// ESC & y c1 c2 [x d1..d(y*x)] for each character c1..c2
const escAmp: Size = (b, i) => {
  if (!need(b, i, 5)) return undefined;
  const y = b[i + 2];
  let at = i + 5;
  for (let c = b[i + 3]; c <= b[i + 4]; c++) {
    if (at >= b.length) return undefined;
    at += 1 + y * b[at];
  }
  return at <= b.length ? at - i : undefined;
};
// GS ( x / ESC ( x / FS ( x pL pH ...
const paren = lengthAt(5, 3);

const S = (name: string, size: Size, support: Support, description: string): CommandSpec => ({ name, size, support, description });

/** Keys: "ESC x", "GS x", "GS ( x"... with x as the literal character. */
export const COMMANDS: CommandSpec[] = [
  S('HT', fixed(1), 'ignored', 'Horizontal tab (tab stops not emulated)'),
  S('LF', fixed(1), 'supported', 'Print and line feed'),
  S('FF', fixed(1), 'ignored', 'Print and return to standard mode (page mode not emulated)'),
  S('CR', fixed(1), 'ignored', 'Carriage return (ignored: auto line feed disabled)'),
  S('CAN', fixed(1), 'ignored', 'Cancel print data in page mode'),
  S('NUL', fixed(1), 'ignored', 'Null'),

  S('DLE EOT', fixed(3), 'supported', 'Real-time status transmission'),
  S('DLE ENQ', fixed(3), 'supported', 'Real-time request to printer (recovery)'),
  S('DLE DC4', dleDc4, 'supported', 'Real-time functions: drawer pulse (fn=1), clear buffers (fn=8)'),

  S('ESC SP', fixed(3), 'supported', 'Right-side character spacing'),
  S('ESC !', fixed(3), 'supported', 'Select print mode(s)'),
  S('ESC $', fixed(4), 'supported', 'Absolute print position'),
  S('ESC %', fixed(3), 'unsupported', 'Select/cancel user-defined character set'),
  S('ESC &', escAmp, 'unsupported', 'Define user-defined characters'),
  S('ESC *', escStar, 'supported', 'Select bit-image mode'),
  S('ESC -', fixed(3), 'supported', 'Underline mode'),
  S('ESC 4', fixed(3), 'ignored', 'Italic (not an Epson command; sent by some encoders)'),
  S('ESC 2', fixed(2), 'supported', 'Default line spacing'),
  S('ESC 3', fixed(3), 'supported', 'Set line spacing'),
  S('ESC =', fixed(3), 'ignored', 'Select peripheral device'),
  S('ESC ?', fixed(3), 'unsupported', 'Cancel user-defined characters'),
  S('ESC @', fixed(2), 'supported', 'Initialize printer'),
  S('ESC D', untilNul(2), 'ignored', 'Set horizontal tab positions'),
  S('ESC E', fixed(3), 'supported', 'Emphasized mode'),
  S('ESC G', fixed(3), 'supported', 'Double-strike mode'),
  S('ESC J', fixed(3), 'supported', 'Print and feed paper'),
  S('ESC L', fixed(2), 'unsupported', 'Select page mode'),
  S('ESC M', fixed(3), 'supported', 'Select character font'),
  S('ESC R', fixed(3), 'ignored', 'Select international character set (only USA emulated)'),
  S('ESC S', fixed(2), 'ignored', 'Select standard mode'),
  S('ESC T', fixed(3), 'unsupported', 'Print direction in page mode'),
  S('ESC U', fixed(3), 'ignored', 'Unidirectional print mode'),
  S('ESC V', fixed(3), 'unsupported', '90° clockwise rotation'),
  S('ESC W', fixed(10), 'unsupported', 'Print area in page mode'),
  S('ESC \\', fixed(4), 'supported', 'Relative print position'),
  S('ESC a', fixed(3), 'supported', 'Justification'),
  S('ESC c 3', fixed(4), 'ignored', 'Paper sensors to output paper-end signals'),
  S('ESC c 4', fixed(4), 'ignored', 'Paper sensors to stop printing'),
  S('ESC c 5', fixed(4), 'ignored', 'Enable/disable panel buttons'),
  S('ESC d', fixed(3), 'supported', 'Print and feed n lines'),
  S('ESC e', fixed(3), 'unsupported', 'Print and reverse feed n lines'),
  S('ESC i', fixed(2), 'supported', 'Partial cut (one point left)'),
  S('ESC m', fixed(2), 'supported', 'Partial cut (three points left)'),
  S('ESC p', fixed(5), 'supported', 'Generate pulse (cash drawer)'),
  S('ESC r', fixed(3), 'ignored', 'Select print color'),
  S('ESC t', fixed(3), 'supported', 'Select character code table'),
  S('ESC u', fixed(3), 'unsupported', 'Transmit peripheral device status'),
  S('ESC v', fixed(2), 'unsupported', 'Transmit paper sensor status'),
  S('ESC {', fixed(3), 'unsupported', 'Upside-down print mode'),
  S('ESC ( A', paren, 'ignored', 'Beeper'),
  S('ESC ( Y', paren, 'unsupported', 'Specify batch print'),

  S('FS !', fixed(3), 'ignored', 'Print mode for Kanji characters'),
  S('FS &', fixed(2), 'ignored', 'Select Kanji character mode'),
  S('FS -', fixed(3), 'ignored', 'Underline for Kanji characters'),
  S('FS .', fixed(2), 'ignored', 'Cancel Kanji character mode'),
  S('FS 2', fixed(76), 'unsupported', 'Define user-defined Kanji characters'),
  S('FS C', fixed(3), 'ignored', 'Kanji character code system'),
  S('FS S', fixed(4), 'ignored', 'Kanji character spacing'),
  S('FS W', fixed(3), 'ignored', 'Quadruple-size Kanji characters'),
  S('FS p', fixed(4), 'unsupported', 'Print NV bit image'),
  S('FS ( A', paren, 'ignored', 'Kanji character style'),
  S('FS ( C', paren, 'ignored', 'Character code / font for Unicode-capable models'),
  S('FS ( E', paren, 'unsupported', 'Receipt enhancement control'),
  S('FS ( L', paren, 'unsupported', 'Label and black mark control'),
  S('FS ( e', paren, 'unsupported', 'Automatic status back for extended status'),

  S('GS !', fixed(3), 'supported', 'Select character size'),
  S('GS $', fixed(4), 'unsupported', 'Absolute vertical position in page mode'),
  S('GS *', gsStar, 'unsupported', 'Define downloaded bit image'),
  S('GS /', fixed(3), 'unsupported', 'Print downloaded bit image'),
  S('GS :', fixed(2), 'ignored', 'Start/end macro definition'),
  S('GS B', fixed(3), 'supported', 'White/black reverse printing'),
  S('GS H', fixed(3), 'supported', 'HRI character print position'),
  S('GS I', fixed(3), 'supported', 'Transmit printer ID'),
  S('GS L', fixed(4), 'supported', 'Left margin'),
  S('GS P', fixed(4), 'supported', 'Horizontal and vertical motion units'),
  S('GS V', gsV, 'supported', 'Select cut mode and cut paper'),
  S('GS W', fixed(4), 'supported', 'Print area width'),
  S('GS \\', fixed(4), 'unsupported', 'Relative vertical position in page mode'),
  S('GS ^', fixed(5), 'ignored', 'Execute macro'),
  S('GS a', fixed(3), 'supported', 'Automatic Status Back (ASB)'),
  S('GS b', fixed(3), 'ignored', 'Font smoothing'),
  S('GS c', fixed(2), 'unsupported', 'Print counter'),
  S('GS f', fixed(3), 'supported', 'HRI font'),
  S('GS g 0', fixed(5), 'unsupported', 'Initialize maintenance counter'),
  S('GS g 2', fixed(5), 'unsupported', 'Transmit maintenance counter'),
  S('GS h', fixed(3), 'supported', 'Barcode height'),
  S('GS j', fixed(3), 'unsupported', 'Automatic Status Back for ink'),
  S('GS k', gsK, 'supported', 'Print barcode'),
  S('GS r', fixed(3), 'supported', 'Transmit status'),
  S('GS v 0', gsV0, 'supported', 'Print raster bit image'),
  S('GS w', fixed(3), 'supported', 'Barcode module width'),
  S('GS z 0', fixed(5), 'ignored', 'Online recovery wait time'),
  S('GS 8 L', gs8L, 'unsupported', 'Graphics data (extended length)'),
  ...'ABCDEGHKLMNPQklpqrsxz'.split('').map((x) =>
    S(`GS ( ${x}`, paren, x === 'k' || x === 'D' ? 'supported' : 'unsupported', `GS ( ${x} function`),
  ),
];

const BY_NAME = new Map(COMMANDS.map((c) => [c.name, c]));

const PREFIX: Record<number, string> = { 0x1b: 'ESC', 0x1d: 'GS', 0x1c: 'FS', 0x10: 'DLE' };
const SINGLE: Record<number, string> = { 0x00: 'NUL', 0x09: 'HT', 0x0a: 'LF', 0x0c: 'FF', 0x0d: 'CR', 0x18: 'CAN' };
const DLE_NAMES: Record<number, string> = { 0x04: 'DLE EOT', 0x05: 'DLE ENQ', 0x14: 'DLE DC4' };
const SUBCOMMAND = new Set(['ESC (', 'FS (', 'GS (', 'GS 8', 'GS g', 'GS v', 'GS z', 'ESC c']);

export type Lookup = { spec: CommandSpec } | { unknown: string; length: number } | undefined;

/** Identify the command starting at b[i] (a control byte). Undefined = need more bytes. */
export function lookup(b: Uint8Array, i: number): Lookup {
  const first = b[i];
  if (SINGLE[first]) return { spec: BY_NAME.get(SINGLE[first])! };
  const prefix = PREFIX[first];
  if (!prefix) return { unknown: `0x${hex(first)}`, length: 1 };
  if (i + 1 >= b.length) return undefined;
  const second = b[i + 1];
  if (prefix === 'DLE') {
    const name = DLE_NAMES[second];
    return name ? { spec: BY_NAME.get(name)! } : { unknown: `DLE 0x${hex(second)}`, length: 2 };
  }
  const key = `${prefix} ${String.fromCharCode(second)}`;
  if (SUBCOMMAND.has(key)) {
    if (i + 2 >= b.length) return undefined;
    const sub = BY_NAME.get(`${key} ${String.fromCharCode(b[i + 2])}`);
    if (sub) return { spec: sub };
    if (key.endsWith('(')) return { spec: { name: `${key} ${String.fromCharCode(b[i + 2])}`, size: paren, support: 'unsupported', description: 'Unlisted function' } };
  }
  const spec = BY_NAME.get(key);
  return spec ? { spec } : { unknown: `${prefix} 0x${hex(second)}`, length: 2 };
}

const hex = (n: number) => n.toString(16).padStart(2, '0');
