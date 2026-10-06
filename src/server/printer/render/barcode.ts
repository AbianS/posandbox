export type BarcodeType = 'UPC-A' | 'UPC-E' | 'EAN13' | 'EAN8' | 'CODE39' | 'ITF' | 'CODABAR' | 'CODE93' | 'CODE128';

export interface EncodedBarcode {
  /** 1 = bar, 0 = space, one entry per module, quiet zones not included. */
  modules: Uint8Array;
  /** Human readable text as Epson prints it. */
  hri: string;
}

const TYPES: BarcodeType[] = ['UPC-A', 'UPC-E', 'EAN13', 'EAN8', 'CODE39', 'ITF', 'CODABAR', 'CODE93', 'CODE128'];

/** Epson GS k `m` value -> type (0-6 NUL-terminated form, 65-73 length form). */
export function barcodeType(m: number): BarcodeType | undefined {
  if (m >= 0 && m <= 6) return TYPES[m];
  if (m >= 65 && m <= 73) return TYPES[m - 65];
}

/** Returns undefined when the data is invalid for that symbology (Epson then prints nothing). */
export function encodeBarcode(type: BarcodeType, data: Uint8Array): EncodedBarcode | undefined {
  const text = String.fromCharCode(...data);
  const result = ENCODERS[type](text, data);
  return result && { modules: Uint8Array.from(result.bars, Number), hri: result.hri };
}

type Encoded = { bars: string; hri: string } | undefined;

const ENCODERS: Record<BarcodeType, (text: string, data: Uint8Array) => Encoded> = {
  'UPC-A': (t) => ean(t, 12, (d) => ean13('0' + d)),
  'UPC-E': upcE,
  EAN13: (t) => ean(t, 13, ean13),
  EAN8: (t) => ean(t, 8, ean8),
  CODE39: code39,
  ITF: itf,
  CODABAR: codabar,
  CODE93: code93,
  CODE128: code128,
};

// Binary symbologies (CODE39, ITF, CODABAR) use narrow:wide = 1:2 modules.
// Real Epson heads print ~1:2.5 (GS w 2 = 0.25/0.625 mm); bump WIDE if pixel fidelity matters.
const WIDE = 2;

/** Alternating bar/space run widths -> module string; 'n'/'w' mean narrow/wide. */
function run(widths: string): string {
  return [...widths.replace(/n/g, '1').replace(/w/g, String(WIDE))]
    .map((w, i) => (i % 2 ? '0' : '1').repeat(Number(w)))
    .join('');
}

const isDigits = (s: string) => /^\d+$/.test(s);

// --- EAN / UPC ---

const L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const R = L.map((p) => p.replace(/./g, (b) => (b === '0' ? '1' : '0')));
const G = R.map((p) => [...p].reverse().join(''));
const EAN13_PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];
const UPCE_PARITY = ['GGGLLL', 'GGLGLL', 'GGLLGL', 'GGLLLG', 'GLGGLL', 'GLLGGL', 'GLLLGG', 'GLGLGL', 'GLGLLG', 'GLLGLG'];

function checkDigit(digits: string): string {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) sum += Number(digits[digits.length - 1 - i]) * (i % 2 ? 1 : 3);
  return String((10 - (sum % 10)) % 10);
}

/** Epson adds the check digit for length-1 data and uses (never validates) a supplied one. */
function ean(text: string, length: number, bars: (digits: string) => string): Encoded {
  if (!isDigits(text) || (text.length !== length && text.length !== length - 1)) return;
  const digits = text.length === length ? text : text + checkDigit(text);
  return { bars: bars(digits), hri: digits };
}

function side(digits: string, parity: string): string {
  return [...digits].map((d, i) => (parity[i] === 'G' ? G : L)[Number(d)]).join('');
}

function ean13(d: string): string {
  const right = [...d.slice(7)].map((c) => R[Number(c)]).join('');
  return '101' + side(d.slice(1, 7), EAN13_PARITY[Number(d[0])]) + '01010' + right + '101';
}

function ean8(d: string): string {
  const right = [...d.slice(4)].map((c) => R[Number(c)]).join('');
  return '101' + side(d.slice(0, 4), 'LLLL') + '01010' + right + '101';
}

/** 6-digit UPC-E code -> the 10 UPC-A digits between number system and check digit. */
function expandUpcE(s: string): string {
  const [a, b, c, d, e, f] = s;
  if (f <= '2') return a + b + f + '0000' + c + d + e;
  if (f === '3') return a + b + c + '00000' + d + e;
  if (f === '4') return a + b + c + d + '00000' + e;
  return a + b + c + d + e + '0000' + f;
}

function compressUpcA(body: string): string | undefined {
  const b = body;
  const candidates = [b[0] + b[1] + b[7] + b[8] + b[9] + b[2], b.slice(0, 3) + b[8] + b[9] + '3', b.slice(0, 4) + b[9] + '4', b.slice(0, 5) + b[9]];
  return candidates.find((c) => expandUpcE(c) === body);
}

/** Epson forms: 6 digits (NSC 0 implied), 7/8 = NSC + code (+ check), 11/12 = UPC-A (+ check). NSC must be 0. */
function upcE(text: string): Encoded {
  if (!isDigits(text) || ![6, 7, 8, 11, 12].includes(text.length)) return;
  if (text.length > 6 && text[0] !== '0') return;
  const short = text.length === 6 ? text : text.length <= 8 ? text.slice(1, 7) : compressUpcA(text.slice(1, 11));
  if (!short) return;
  const check = text.length === 8 || text.length === 12 ? text.at(-1)! : checkDigit('0' + expandUpcE(short));
  return { bars: '101' + side(short, UPCE_PARITY[Number(check)]) + '010101', hri: short };
}

// --- CODE39 ---

const CODE39_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-. $/+%*';
const CODE39 = [
  'nnnwwnwnn', 'wnnwnnnnw', 'nnwwnnnnw', 'wnwwnnnnn', 'nnnwwnnnw', 'wnnwwnnnn', 'nnwwwnnnn', 'nnnwnnwnw', 'wnnwnnwnn', 'nnwwnnwnn',
  'wnnnnwnnw', 'nnwnnwnnw', 'wnwnnwnnn', 'nnnnwwnnw', 'wnnnwwnnn', 'nnwnwwnnn', 'nnnnnwwnw', 'wnnnnwwnn', 'nnwnnwwnn', 'nnnnwwwnn',
  'wnnnnnnww', 'nnwnnnnww', 'wnwnnnnwn', 'nnnnwnnww', 'wnnnwnnwn', 'nnwnwnnwn', 'nnnnnnwww', 'wnnnnnwwn', 'nnwnnnwwn', 'nnnnwnwwn',
  'wwnnnnnnw', 'nwwnnnnnw', 'wwwnnnnnn', 'nwnnwnnnw', 'wwnnwnnnn', 'nwwnwnnnn', 'nwnnnnwnw', 'wwnnnnwnn', 'nwwnnnwnn', 'nwnwnwnnn',
  'nwnwnnnwn', 'nwnnnwnwn', 'nnnwnwnwn', 'nwnnwnwnn',
];

/** A leading '*' is the start char; the next '*' (or end of data) is the stop char. */
function code39(text: string): Encoded {
  const body = (text.startsWith('*') ? text.slice(1) : text).split('*')[0];
  if (!body || [...body].some((c) => !CODE39_CHARS.includes(c))) return;
  const hri = `*${body}*`;
  return { bars: [...hri].map((c) => run(CODE39[CODE39_CHARS.indexOf(c)])).join('0'), hri };
}

// --- ITF ---

const ITF = ['nnwwn', 'wnnnw', 'nwnnw', 'wwnnn', 'nnwnw', 'wnwnn', 'nwwnn', 'nnnww', 'wnnwn', 'nwnwn'];

/** Epson ignores a trailing odd digit. */
function itf(text: string): Encoded {
  const digits = text.slice(0, text.length & ~1);
  if (!isDigits(text) || !digits) return;
  let widths = 'nnnn';
  for (let i = 0; i < digits.length; i += 2) {
    const [bars, spaces] = [ITF[Number(digits[i])], ITF[Number(digits[i + 1])]];
    for (let j = 0; j < 5; j++) widths += bars[j] + spaces[j];
  }
  return { bars: run(widths + 'wnn'), hri: digits };
}

// --- CODABAR ---

const CODABAR_CHARS = '0123456789-$:/.+ABCD';
const CODABAR = [
  'nnnnnww', 'nnnnwwn', 'nnnwnnw', 'wwnnnnn', 'nnwnnwn', 'wnnnnwn', 'nwnnnnw', 'nwnnwnn', 'nwwnnnn', 'wnnwnnn',
  'nnnwwnn', 'nnwwnnn', 'wnnnwnw', 'wnwnnnw', 'wnwnwnn', 'nnwnwnw', 'nnwwnwn', 'nwnwnnw', 'nnnwnww', 'nnnwwwn',
];

/** Start/stop chars A-D (a-d) must be supplied at both ends and nowhere else. */
function codabar(text: string): Encoded {
  const upper = text.toUpperCase();
  if (!/^[A-D][0-9\-$:/.+]*[A-D]$/.test(upper)) return;
  return { bars: [...upper].map((c) => run(CODABAR[CODABAR_CHARS.indexOf(c)])).join('0'), hri: text };
}

// --- CODE93 ---

const CODE93_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-. $/+%';
const CODE93 = [
  '100010100', '101001000', '101000100', '101000010', '100101000', '100100100', '100100010', '101010000', '100010010', '100001010',
  '110101000', '110100100', '110100010', '110010100', '110010010', '110001010', '101101000', '101100100', '101100010', '100110100',
  '100011010', '101011000', '101001100', '101000110', '100101100', '100010110', '110110100', '110110010', '110101100', '110100110',
  '110010110', '110011010', '101101100', '101100110', '100110110', '100111010', '100101110', '111010100', '111010010', '111001010',
  '101101110', '101110110', '110101110', '100100110', '111011010', '111010110', '100110010',
];
const CODE93_START_STOP = '101011110';
const SHIFT = { $: 43, '%': 44, '/': 45, '+': 46 };

/** Full-ASCII CODE93: a char is either native or a (shift, letter) pair. */
function code93Pair(c: number): [keyof typeof SHIFT, string] | undefined {
  const letter = (base: number, from: number) => String.fromCharCode(base + c - from);
  if (c === 0) return ['%', 'U'];
  if (c <= 26) return ['$', letter(65, 1)];
  if (c <= 31) return ['%', letter(65, 27)];
  if (c >= 33 && c <= 44) return ['/', letter(65, 33)];
  if (c === 47) return ['/', 'O'];
  if (c === 58) return ['/', 'Z'];
  if (c >= 59 && c <= 63) return ['%', letter(70, 59)];
  if (c === 64) return ['%', 'V'];
  if (c >= 91 && c <= 95) return ['%', letter(75, 91)];
  if (c === 96) return ['%', 'W'];
  if (c >= 97 && c <= 122) return ['+', letter(65, 97)];
  if (c >= 123) return ['%', letter(80, 123)];
}

function code93Check(values: number[], maxWeight: number): number {
  return values.reduceRight((sum, v, i) => sum + v * (((values.length - 1 - i) % maxWeight) + 1), 0) % 47;
}

/** HRI: '□' for start/stop, '■' + letter for control characters. */
function code93(_text: string, data: Uint8Array): Encoded {
  const values: number[] = [];
  let hri = '□';
  for (const c of data) {
    if (c > 127) return;
    const pair = code93Pair(c);
    if (!pair) {
      values.push(CODE93_CHARS.indexOf(String.fromCharCode(c)));
      hri += String.fromCharCode(c);
      continue;
    }
    values.push(SHIFT[pair[0]], CODE93_CHARS.indexOf(pair[1]));
    hri += c < 32 || c === 127 ? '■' + pair[1] : String.fromCharCode(c);
  }
  if (!values.length) return;
  values.push(code93Check(values, 20));
  values.push(code93Check(values, 15));
  return { bars: CODE93_START_STOP + values.map((v) => CODE93[v]).join('') + CODE93_START_STOP + '1', hri: hri + '□' };
}

// --- CODE128 ---

const CODE128 = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232',
];
const START = { A: 103, B: 104, C: 105 };
const SWITCH = { A: 101, B: 100, C: 99 };
type CodeSet = keyof typeof START;

/**
 * Data must start with {A, {B or {C. `{x` is a special: code set switch, {S shift, {1-{4 FNC1-4, {{ literal '{'.
 * In code set C each byte is a value 0-99. HRI omits shift/switches; FNC and control chars print as spaces.
 */
function code128(_text: string, data: Uint8Array): Encoded {
  const values: number[] = [];
  let hri = '';
  let set: CodeSet | undefined;
  let shift = false;
  for (let i = 0; i < data.length; i++) {
    const c = data[i];
    if (c === 0x7b) {
      const s = String.fromCharCode(data[++i] ?? 0);
      if (s === 'A' || s === 'B' || s === 'C') {
        if (s === set) return;
        values.push(set ? SWITCH[s] : START[s]);
        set = s;
        continue;
      }
      if (!set) return;
      if (s !== '{') {
        const fn = ({ S: 98, '1': 102, '2': 97, '3': 96, '4': set === 'A' ? 101 : 100 } as Record<string, number>)[s];
        if (fn === undefined || (set === 'C' && s !== '1')) return;
        values.push(fn);
        if (s === 'S') shift = true;
        else hri += ' ';
        continue;
      }
    }
    if (!set) return;
    if (set === 'C') {
      if (c > 99) return;
      values.push(c);
      hri += String(c).padStart(2, '0');
      continue;
    }
    const current = shift ? (set === 'A' ? 'B' : 'A') : set;
    shift = false;
    if (current === 'A' ? c > 0x5f : c < 0x20 || c > 0x7f) return;
    values.push(c >= 32 ? c - 32 : c + 64);
    hri += c < 32 || c === 127 ? ' ' : String.fromCharCode(c);
  }
  if (values.length < 2) return;
  const check = values.reduce((sum, v, i) => sum + v * Math.max(i, 1), 0) % 103;
  return { bars: [...values, check].map((v) => run(CODE128[v])).join('') + run('2331112'), hri };
}
