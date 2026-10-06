import type { PrinterFault } from '../../../shared/contract.ts';

// Status bytes of the Epson TM-T20III (ESC/POS reference: DLE EOT, GS r, GS a, GS I).

export interface StatusState {
  faults: Record<PrinterFault, boolean>;
  /** Drawer kick-out connector pin 3 is HIGH (drawer sensor). */
  drawerPin3: boolean;
  /** Paper is being fed with the FEED button. */
  feeding: boolean;
}

export const isOffline = (s: StatusState) => s.faults.paperOut || s.faults.coverOpen || s.faults.headOverheat || s.feeding;
/** Paper-out also trips the near-end sensor. */
const nearEnd = (s: StatusState) => s.faults.paperNearEnd || s.faults.paperOut;

const bits = (...pairs: [boolean, number][]) => pairs.reduce((acc, [on, bit]) => (on ? acc | bit : acc), 0);

/** DLE EOT n (n = 1..4). Every byte has the fixed bits 0x12. */
export function dleEot(n: number, s: StatusState): Uint8Array | undefined {
  const { faults: f } = s;
  switch (n) {
    case 1: return Uint8Array.of(0x12 | bits([s.drawerPin3, 0x04], [isOffline(s), 0x08]));
    case 2: return Uint8Array.of(0x12 | bits([f.coverOpen, 0x04], [s.feeding, 0x08], [f.paperOut, 0x20], [f.headOverheat, 0x40]));
    case 3: return Uint8Array.of(0x12 | bits([f.headOverheat, 0x40]));
    case 4: return Uint8Array.of(0x12 | bits([nearEnd(s), 0x0c], [f.paperOut, 0x60]));
    default: return undefined;
  }
}

/** GS r n: 1/49 paper sensor, 2/50 drawer. No fixed bits. */
export function gsR(n: number, s: StatusState): Uint8Array | undefined {
  if (n === 1 || n === 49) return Uint8Array.of(bits([nearEnd(s), 0x03], [s.faults.paperOut, 0x0c]));
  if (n === 2 || n === 50) return Uint8Array.of(bits([s.drawerPin3, 0x01]));
  return undefined;
}

/** Automatic Status Back: 4 bytes. */
export function asb(s: StatusState): Uint8Array {
  const { faults: f } = s;
  return Uint8Array.of(
    0x10 | bits([s.drawerPin3, 0x04], [isOffline(s), 0x08], [f.coverOpen, 0x20], [s.feeding, 0x40]),
    bits([f.headOverheat, 0x40]),
    bits([nearEnd(s), 0x03], [f.paperOut, 0x0c]),
    0x00,
  );
}

const info = (text: string) => Uint8Array.from([0x5f, ...Buffer.from(text, 'latin1'), 0x00]);

/** GS I n. Firmware and serial formats are not documented by Epson: lab values. */
export function gsI(n: number): Uint8Array | undefined {
  switch (n) {
    case 1: case 49: return Uint8Array.of(0x63); // model ID
    case 2: case 50: return Uint8Array.of(0x02); // type ID: autocutter installed
    case 35: return Uint8Array.of(0x3d, 0x23, 0x30, 0x00);
    case 65: return info('POSANDBOX-1.0');
    case 66: return info('EPSON');
    case 67: return info('TM-T20III');
    case 68: return info('PSBX000001');
    case 69: return info('');
    default: return undefined;
  }
}
