// Printer body dimensions (metres, origin at the printer's base centre, +z = front) and the
// centre line of the paper strip as it leaves the slot.

// Modern "cube" receipt printer, top paper exit (TSP100 / TM-m30 class: 127 × 127 × 131 mm).
// These profiles are the exact top surfaces built in PrinterModel.tsx, so paper and body never disagree.
export const PRINTER = { width: 0.127, depth: 0.127, height: 0.131, bodyHeight: 0.1175 };
const REAR = -PRINTER.depth / 2;
const FRONT = PRINTER.depth / 2;

/** Paper exit slot across the top, between the top cover and the front lip. */
export const SLOT = { z: 0.042, y: 0.131 };

/** Top cover (hinged at the back): flat, with a 3 mm rounded rear edge. */
export const LID_PROFILE: [number, number][] = [
  [0.038, 0.131], [-0.0595, 0.131], [-0.0618, 0.13], [-0.0631, 0.1282], [REAR, 0.1255],
];
/** Front lip (tear bar side): flat, with a rounded front edge. */
export const FRONT_PROFILE: [number, number][] = [[0.046, 0.1305], [0.0595, 0.1305], [0.0618, 0.1295], [0.0631, 0.1277], [FRONT, 0.125]];

/**
 * What the paper needs to know about a printer body: footprint, exit slot and the height of its top
 * along the centre line ([z, y] pairs, any order). Measured from the 3D model it belongs to.
 */
export interface PrinterShape {
  width: number;
  depth: number;
  slot: { z: number; y: number };
  top: [number, number][];
}

export const CUBE_SHAPE: PrinterShape = {
  width: PRINTER.width,
  depth: PRINTER.depth,
  slot: SLOT,
  top: [...LID_PROFILE, ...FRONT_PROFILE],
};

const GAP = 0.0006; // paper rests just above surfaces

/** Height of whatever is under the paper at depth z: the printer top, or the surface it stands on (0). */
export function surfaceHeight(z: number, shape: PrinterShape = CUBE_SHAPE): number {
  if (z < -shape.depth / 2 || z > shape.depth / 2) return 0;
  if (Math.abs(z - shape.slot.z) < 0.004) return shape.slot.y - 0.002; // the slot itself
  const top = sorted(shape);
  if (z <= top[0][0]) return top[0][1];
  for (let i = 1; i < top.length; i++) {
    const [z0, y0] = top[i - 1];
    const [z1, y1] = top[i];
    if (z <= z1) return y0 + ((z - z0) / (z1 - z0 || 1)) * (y1 - y0);
  }
  return top.at(-1)![1];
}

const sortedCache = new WeakMap<PrinterShape, [number, number][]>();
function sorted(shape: PrinterShape): [number, number][] {
  let top = sortedCache.get(shape);
  if (!top) sortedCache.set(shape, (top = [...shape.top].sort((a, b) => a[0] - b[0])));
  return top;
}

/**
 * Centre line of a strip of `length` metres, sampled at `segments + 1` points as [z0, y0, z1, y1, ...]
 * from the slot to the tip. The strip rises straight out of the slot, then curls backwards (roll memory
 * plus gravity, printed face outwards) and rests on the lid and the counter when it touches them.
 */
export function paperPath(length: number, segments: number, out = new Float32Array((segments + 1) * 2), shape: PrinterShape = CUBE_SHAPE): Float32Array {
  const RISE = 0.012;
  const radius = Math.min(0.1, Math.max(0.034, 0.1 - 0.22 * length));
  const substeps = 8;
  const ds = length / (segments * substeps);
  const surface = (zz: number) => surfaceHeight(zz, shape);
  let z = shape.slot.z;
  let y = shape.slot.y;
  let theta = 0; // 0 = up, π/2 = backwards, π = down
  let s = 0;
  out[0] = z;
  out[1] = y;
  for (let i = 1; i <= segments; i++) {
    for (let k = 0; k < substeps; k++) {
      s += ds;
      if (s > RISE) theta = Math.min(Math.PI, theta + ds / radius);
      let nz = z - Math.sin(theta) * ds;
      let ny = y + Math.cos(theta) * ds;
      const floor = surface(nz) + GAP;
      if (ny < floor) {
        // touching: keep the step length, sliding along the surface
        let dz = nz - z;
        let dy = floor - y;
        if (Math.hypot(dz, dy) < ds / 2) {
          dz = -1e-4;
          dy = surface(z - 1e-4) - surface(z);
        }
        const n = Math.hypot(dz, dy);
        nz = z + (dz / n) * ds;
        ny = Math.max(y + (dy / n) * ds, surface(nz) + GAP);
        theta = Math.atan2(z - nz, ny - y);
      }
      z = nz;
      y = ny;
    }
    out[i * 2] = z;
    out[i * 2 + 1] = y;
  }
  return out;
}

/**
 * Largest animation step per frame (s). Animations use real elapsed time so they last the same at any
 * frame rate; the cap only avoids a jump after the tab was in the background.
 */
export const MAX_STEP = 0.1;
