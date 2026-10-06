import * as THREE from 'three';

/** A place on the workbench mat. Devices that exist are placed on their slot; the rest are printed outlines. */
export interface BenchSlot {
  kind: 'printer' | 'drawer' | 'terminal' | 'scanner';
  label: string;
  x: number;
  z: number;
  width: number;
  depth: number;
  available: boolean;
}

export const MAT = { width: 0.94, depth: 0.46, z: 0.02, thickness: 0.003 };
export const WALL_Z = -0.34;
/** The desk runs from the wall (slightly into it: no gap at the corner) to its front edge at z = 0.45. */
export const DESK = { width: 2.8, depth: 0.795, thickness: 0.038, z: 0.0525 };

export const SLOTS: BenchSlot[] = [
  { kind: 'printer', label: 'RECEIPT PRINTER · ESC/POS TCP', x: -0.34, z: -0.04, width: 0.17, depth: 0.17, available: true },
  { kind: 'drawer', label: 'CASH DRAWER · RJ12 TO PRINTER', x: -0.03, z: -0.015, width: 0.38, depth: 0.37, available: true },
  { kind: 'terminal', label: 'PAYMENT TERMINAL · TERMINAL API', x: 0.24, z: -0.03, width: 0.105, depth: 0.205, available: true },
  { kind: 'scanner', label: 'SCANNER · USB HID', x: 0.385, z: -0.06, width: 0.11, depth: 0.09, available: true },
];

/**
 * Where the i-th printer stands (extra printers line up to the left of the first slot).
 * Stations stand on the desk pad, so their local y = 0 (paper resting, cut tickets) is the pad surface.
 */
export function printerPosition(index: number): [number, number, number] {
  const slot = SLOTS[0];
  return [slot.x - index * 0.2, MAT.thickness + 0.0002, slot.z];
}

/** The cash drawer stands on its slot, wired to the first printer. */
export function drawerPosition(): [number, number, number] {
  const slot = SLOTS[1];
  return [slot.x, MAT.thickness + 0.0002, slot.z];
}

/** The payment terminal stands on its slot. */
export function terminalPosition(): [number, number, number] {
  const slot = SLOTS[2];
  return [slot.x, MAT.thickness + 0.0002, slot.z];
}

/** The scanner's stand and its products. */
export function scannerPosition(): [number, number, number] {
  const slot = SLOTS[3];
  return [slot.x, MAT.thickness + 0.0002, slot.z + 0.015];
}

const PX_PER_M = 2000;

/** Printed markings for the desk pad (transparent): the device slots and their labels. */
export function padMarkings(): THREE.CanvasTexture {
  const w = Math.round(MAT.width * PX_PER_M);
  const h = Math.round(MAT.depth * PX_PER_M);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const toPx = (x: number, z: number) => [(x + MAT.width / 2) * PX_PER_M, (z - MAT.z + MAT.depth / 2) * PX_PER_M];
  for (const slot of SLOTS) {
    const [cx, cy] = toPx(slot.x, slot.z);
    const sw = slot.width * PX_PER_M;
    const sd = slot.depth * PX_PER_M;
    ctx.strokeStyle = slot.available ? 'rgba(236,238,240,0.42)' : 'rgba(236,238,240,0.22)';
    ctx.lineWidth = 3;
    ctx.setLineDash(slot.available ? [] : [14, 10]);
    roundRect(ctx, cx - sw / 2, cy - sd / 2, sw, sd, 18);
    ctx.stroke();
    ctx.setLineDash([]);
    const [first, second] = slot.label.split(' · ');
    ctx.textAlign = 'center';
    ctx.fillStyle = slot.available ? 'rgba(236,238,240,0.6)' : 'rgba(236,238,240,0.32)';
    ctx.font = '600 15px system-ui, sans-serif';
    ctx.fillText(first, cx, cy + sd / 2 + 28);
    ctx.font = '500 13px system-ui, sans-serif';
    if (second) ctx.fillText(second, cx, cy + sd / 2 + 48);
  }
  ctx.textAlign = 'start';
  ctx.fillStyle = 'rgba(236,238,240,0.3)';
  ctx.font = '700 17px system-ui, sans-serif';
  ctx.fillText('POSANDBOX', 28, h - 26);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
