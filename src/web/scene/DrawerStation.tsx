import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { Html, useTexture } from '@react-three/drei';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { PrinterSnapshot } from '../../shared/contract.ts';
import { api } from '../store.ts';
import { drawerPosition, printerPosition } from './bench.ts';
import { MAX_STEP, PRINTER } from './paper-path.ts';
import { footprint, slab, usePlastic } from './PrinterModel.tsx';
import { drawerSound } from './sound.ts';

// Compact steel cash drawer (360 × 360 × 100 mm, 4 note / 8 coin insert), wired to the printer's RJ12
// drawer-kick connector. Origin: base centre, +z = front. The tray slides out on telescopic rails.

const W = 0.36;
const D = 0.36;
const H = 0.1;
const SHEET = 0.0012; // steel sheet
const FEET = 0.005;
const TRAVEL = 0.26;
const RAIL = 0.0026; // each of the three telescopic members
const OPEN_TIME = 0.3; // spring kick to the end stop
const CLOSE_TIME = 0.42; // pushed back by hand
const SETTLE = 0.6;

const TRAY_HALF = W / 2 - SHEET - 3 * RAIL;
const TRAY_BACK = -D / 2 + 0.012;
const IN = TRAY_HALF - SHEET; // insert half width
const FLOOR = 0.013; // insert floor: where notes and coins lie
const PANEL_FRONT = D / 2 + 0.0145;
const IN_FRONT = D / 2 - 0.0022;
const COIN_BACK = IN_FRONT - 0.083;
const BILL_W = (2 * IN) / 4;
const CUP_W = (2 * IN) / 8;
const PIVOT = { y: 0.045, z: -0.1 }; // bill weights hinge
const PADDLE = { length: 0.115, angle: Math.asin((PIVOT.y - FLOOR - 0.0045) / 0.115) };

/** Rounded box in drawer coordinates, with metre UVs (the grain normal map stays the same scale everywhere). */
function box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, r = 0.001, bevel = 0.0005) {
  const radius = Math.min(r, (Math.min(x1 - x0, z1 - z0) / 2) * 0.9);
  return slab(footprint(x0, z0, x1, z1, [radius, radius, radius, radius]), y0, y1, Math.min(bevel, radius * 0.8, ((y1 - y0) / 2) * 0.8));
}

const merge = (parts: THREE.BufferGeometry[]) => {
  const merged = mergeGeometries(parts.map((g) => (g.index ? g.toNonIndexed() : g)));
  parts.forEach((g) => g.dispose());
  return merged;
};

const rod = (radius: number, length: number, at: [number, number, number]) =>
  new THREE.CylinderGeometry(radius, radius, length, 20).rotateZ(Math.PI / 2).translate(...at);

/** Telescopic slide member on both sides, `index` 0 = fixed to the housing, 2 = fixed to the tray. */
function railMember(index: number, z0: number, z1: number) {
  const outer = W / 2 - SHEET - index * RAIL;
  return [-1, 1].map((side) => {
    const [a, b] = [side * (outer - RAIL), side * outer];
    return box(Math.min(a, b), Math.max(a, b), 0.028, 0.046, z0, z1, 0.0005, 0.0003);
  });
}

function useGeometry() {
  const geometry = useMemo(() => {
    // housing: one folded sheet (top, sides, bottom) extruded front to back, open at the front
    const bevel = 0.0003;
    const shell = footprint(-W / 2, -H, W / 2, -FEET, [0.003, 0.003, 0.003, 0.003]);
    shell.holes.push(footprint(-W / 2 + SHEET, -(H - SHEET), W / 2 - SHEET, -(FEET + SHEET), [0.0018, 0.0018, 0.0018, 0.0018]));
    const housing = new THREE.ExtrudeGeometry(shell, {
      depth: D - 2 * bevel, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelOffset: -bevel, bevelSegments: 2, curveSegments: 6,
    }).translate(0, 0, -D / 2 + bevel);

    const paddles = Array.from({ length: 4 }, (_, k) => {
      const cx = -IN + BILL_W * (k + 0.5);
      const m = new THREE.Matrix4().makeTranslation(cx, PIVOT.y, PIVOT.z).multiply(new THREE.Matrix4().makeRotationX(PADDLE.angle));
      return [
        box(-0.0075, 0.0075, -0.0025, 0, 0, PADDLE.length, 0.003, 0.0008).applyMatrix4(m),
        box(-0.011, 0.011, -0.0025, 0.007, PADDLE.length - 0.008, PADDLE.length, 0.003, 0.0012).applyMatrix4(m), // finger tab
      ];
    }).flat();

    return {
      housing: merge([housing, box(-W / 2 + SHEET, W / 2 - SHEET, FEET + SHEET, H - SHEET, -D / 2, -D / 2 + SHEET)]),
      housingRails: merge(railMember(0, -D / 2 + 0.01, D / 2 - 0.003)),
      middleRails: merge(railMember(1, -D / 2 + 0.01, D / 2 - 0.003)),
      feet: merge([-1, 1].flatMap((sx) => [-1, 1].map((sz) => new THREE.CylinderGeometry(0.008, 0.009, FEET, 24).translate(sx * (W / 2 - 0.03), FEET / 2, sz * (D / 2 - 0.03))))),
      // tray: steel pan, sides and back, behind the front panel
      tray: merge([
        box(-W / 2 + 0.001, W / 2 - 0.001, 0.0055, H - 0.0015, D / 2 + 0.0005, PANEL_FRONT, 0.004, 0.002), // front panel
        box(-W / 2 + SHEET + 0.0005, W / 2 - SHEET - 0.0005, FEET + SHEET + 0.0002, H - SHEET - 0.0002, D / 2 - 0.001, D / 2 + 0.0006), // its inner sheet: closes the parting line
        box(-TRAY_HALF, TRAY_HALF, 0.0085, 0.0097, TRAY_BACK, D / 2),
        box(-TRAY_HALF, -TRAY_HALF + SHEET, 0.0085, 0.062, TRAY_BACK, D / 2),
        box(TRAY_HALF - SHEET, TRAY_HALF, 0.0085, 0.062, TRAY_BACK, D / 2),
        box(-TRAY_HALF, TRAY_HALF, 0.0085, 0.062, TRAY_BACK, TRAY_BACK + SHEET),
      ]),
      trayRails: merge(railMember(2, TRAY_BACK, D / 2 - 0.003)),
      // moulded ABS insert: floor, walls, dividers, bill weights and their hinge brackets
      insert: merge([
        box(-IN, IN, 0.0097, FLOOR, TRAY_BACK + SHEET, D / 2),
        box(-IN, IN, FLOOR, 0.042, COIN_BACK - 0.0022, COIN_BACK, 0.001, 0.0008),
        box(-IN, IN, FLOOR, 0.03, IN_FRONT, D / 2, 0.001, 0.0008),
        ...[1, 2, 3, 4, 5, 6, 7].map((k) => box(-IN + k * CUP_W - 0.0011, -IN + k * CUP_W + 0.0011, FLOOR, 0.03, COIN_BACK, IN_FRONT, 0.001, 0.0008)),
        ...[1, 2, 3].map((k) => box(-IN + k * BILL_W - 0.0011, -IN + k * BILL_W + 0.0011, FLOOR, 0.058, TRAY_BACK + SHEET, COIN_BACK - 0.0022, 0.001, 0.0008)),
        ...[-1, 1].map((side) => box(side * IN - (side > 0 ? 0.004 : 0), side * IN + (side < 0 ? 0.004 : 0), FLOOR, PIVOT.y + 0.004, PIVOT.z - 0.005, PIVOT.z + 0.005)),
        ...paddles,
      ]),
      hinge: rod(0.0021, 2 * IN - 0.002, [0, PIVOT.y, PIVOT.z]),
      lockBezel: new THREE.CylinderGeometry(0.0098, 0.0104, 0.003, 48).rotateX(Math.PI / 2).translate(0, 0, 0.0015),
      lockFace: new THREE.CylinderGeometry(0.0074, 0.0074, 0.0036, 48).rotateX(Math.PI / 2).translate(0, 0, 0.0018),
    };
  }, []);
  useLayoutEffect(() => () => Object.values(geometry).forEach((g) => g.dispose()), [geometry]);
  return geometry;
}

/** Powder-coated steel: a fine orange-peel texture under a thin satin coat. */
function usePowderCoat() {
  const normal = useTexture('/textures/plastic_nor_gl.jpg');
  return useMemo(() => {
    const peel = normal.clone();
    peel.wrapS = peel.wrapT = THREE.RepeatWrapping;
    peel.repeat.set(160, 160);
    peel.anisotropy = 8;
    peel.needsUpdate = true;
    return new THREE.MeshPhysicalMaterial({
      color: '#1d1e21', roughness: 0.5, normalMap: peel, normalScale: new THREE.Vector2(0.22, 0.22), clearcoat: 0.3, clearcoatRoughness: 0.42, envMapIntensity: 0.85,
    });
  }, [normal]);
}

const METALS = {
  chrome: new THREE.MeshStandardMaterial({ color: '#dcdee2', metalness: 1, roughness: 0.14 }),
  rail: new THREE.MeshStandardMaterial({ color: '#a8acb2', metalness: 1, roughness: 0.3 }),
  nickel: new THREE.MeshStandardMaterial({ color: '#b5b8bd', metalness: 1, roughness: 0.38 }),
  gold: new THREE.MeshStandardMaterial({ color: '#cfa94c', metalness: 1, roughness: 0.3 }), // Nordic gold: 10-50 cent, 1 € ring, 2 € centre
  silver: new THREE.MeshStandardMaterial({ color: '#c9cbce', metalness: 1, roughness: 0.27 }), // cupronickel
  copper: new THREE.MeshStandardMaterial({ color: '#b9693e', metalness: 1, roughness: 0.34 }), // copper-plated steel: 1-5 cent
};

// ---- money ----

type Metal = 'gold' | 'silver' | 'copper';
/** Euro coins, one per cup from left to right: diameter and thickness in mm, outer metal, inner metal (bimetallic). */
const COINS: [number, number, Metal, Metal?][] = [
  [25.75, 2.2, 'silver', 'gold'],
  [23.25, 2.33, 'gold', 'silver'],
  [24.25, 2.38, 'gold'],
  [22.25, 2.14, 'gold'],
  [19.75, 1.93, 'gold'],
  [21.25, 1.67, 'copper'],
  [18.75, 1.67, 'copper'],
  [16.25, 1.67, 'copper'],
];

/** Deterministic random: the same coins every time the panel opens. */
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface CoinInstance { metal: Metal; matrix: THREE.Matrix4; shade: number }

/** A loose heap in each cup: coins rest flat on the floor or tilted on the coins they overlap. */
function coinHeaps(): CoinInstance[] {
  const rnd = random(7);
  const out: CoinInstance[] = [];
  const zMid = (COIN_BACK + IN_FRONT) / 2;
  COINS.forEach(([diameter, thickness, outer, inner], cup) => {
    const r = diameter / 2000;
    const h = thickness / 1000;
    const cx = -IN + CUP_W * (cup + 0.5);
    const spreadX = CUP_W / 2 - 0.0011 - r - 0.0006;
    const spreadZ = (IN_FRONT - COIN_BACK) / 2 - r - 0.002;
    const placed: { x: number; z: number; top: number }[] = [];
    const count = 8 + Math.floor(rnd() * 7);
    for (let i = 0; i < count; i++) {
      const x = cx + (rnd() * 2 - 1) * spreadX;
      const z = zMid + (rnd() * 2 - 1) * spreadZ;
      const under = placed.filter((p) => Math.hypot(p.x - x, p.z - z) < 2 * r * 0.95);
      const base = Math.max(FLOOR, ...under.map((p) => p.top));
      const tilt = under.length ? 0.06 + rnd() * 0.12 : rnd() * 0.02;
      const y = base + h / 2 + (under.length ? Math.sin(tilt) * r * 0.6 : 0) + 0.00005;
      placed.push({ x, z, top: y + h / 2 });
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(tilt * Math.cos(i * 2.3), rnd() * Math.PI * 2, tilt * Math.sin(i * 2.3)));
      const shade = 0.85 + rnd() * 0.25;
      const at = new THREE.Vector3(x, y, z);
      out.push({ metal: outer, matrix: new THREE.Matrix4().compose(at, q, new THREE.Vector3(r, h, r)), shade });
      if (inner) out.push({ metal: inner, matrix: new THREE.Matrix4().compose(at, q, new THREE.Vector3(r * 0.71, h + 0.0002, r * 0.71)), shade });
    }
  });
  return out;
}

function Coins() {
  const heaps = useMemo(coinHeaps, []);
  const disc = useMemo(() => new THREE.CylinderGeometry(1, 1, 1, 40), []);
  useEffect(() => () => disc.dispose(), [disc]);
  return (['gold', 'silver', 'copper'] as const).map((metal) => <CoinBatch key={metal} geometry={disc} material={METALS[metal]} coins={heaps.filter((c) => c.metal === metal)} />);
}

function CoinBatch({ geometry, material, coins }: { geometry: THREE.BufferGeometry; material: THREE.Material; coins: CoinInstance[] }) {
  const mesh = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    const color = new THREE.Color();
    coins.forEach((c, i) => {
      mesh.current!.setMatrixAt(i, c.matrix);
      mesh.current!.setColorAt(i, color.setScalar(c.shade));
    });
    mesh.current!.instanceMatrix.needsUpdate = true;
    if (mesh.current!.instanceColor) mesh.current!.instanceColor.needsUpdate = true;
  }, [coins]);
  return <instancedMesh ref={mesh} args={[geometry, material, coins.length]} />;
}

/** Euro-sized notes: value, size in mm, colour. The print is a stylised look-alike, not a reproduction. */
const NOTES: [number, number, number, string][] = [
  [5, 120, 62, '#8d9a92'],
  [10, 127, 67, '#c4574f'],
  [20, 133, 72, '#5079b4'],
  [50, 140, 77, '#dd8a3d'],
];

function noteTexture(value: number, color: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 512, 256);
  const light = ctx.createRadialGradient(400, 128, 10, 400, 128, 150);
  light.addColorStop(0, 'rgba(255,255,255,0.55)');
  light.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = light;
  ctx.fillRect(0, 0, 512, 256);
  // fine guilloche lines
  ctx.strokeStyle = 'rgba(0,0,0,0.12)';
  ctx.lineWidth = 1;
  for (let k = 0; k < 14; k++) {
    ctx.beginPath();
    for (let x = 0; x <= 512; x += 8) ctx.lineTo(x, 30 + k * 15 + Math.sin(x / 26 + k) * 6);
    ctx.stroke();
  }
  // arches
  ctx.strokeStyle = 'rgba(0,0,0,0.28)';
  ctx.lineWidth = 5;
  for (let i = 0; i < 3; i++) {
    const x = 150 + i * 52;
    ctx.beginPath();
    ctx.moveTo(x, 210);
    ctx.lineTo(x, 120);
    ctx.arc(x + 22, 120, 22, Math.PI, 0);
    ctx.lineTo(x + 44, 210);
    ctx.stroke();
  }
  // foil stripe
  const foil = ctx.createLinearGradient(80, 0, 112, 0);
  foil.addColorStop(0, '#9da3aa');
  foil.addColorStop(0.5, '#eef1f4');
  foil.addColorStop(1, '#9da3aa');
  ctx.fillStyle = foil;
  ctx.fillRect(80, 0, 32, 256);
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 3;
  ctx.font = '800 76px system-ui, sans-serif';
  ctx.strokeText(String(value), 14, 80);
  ctx.fillText(String(value), 14, 80);
  ctx.font = '800 44px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.textAlign = 'right';
  ctx.fillText(String(value), 496, 236);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

/** A stack of notes under its bill weight, with a couple of loose, slightly curled ones on top. */
function NoteStack({ index }: { index: number }) {
  const [value, length, width, color] = NOTES[index];
  const [l, w] = [length / 1000, width / 1000];
  const z = 0.045 - l / 2;
  const x = -IN + BILL_W * (index + 0.5);
  const stack = 0.0034;
  const { texture, curl, side } = useMemo(() => {
    const curl = new THREE.PlaneGeometry(l, w, 12, 1).rotateX(-Math.PI / 2);
    const p = curl.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) p.setY(i, 0.0015 * (2 * p.getX(i) / l) ** 2);
    curl.computeVertexNormals();
    return { texture: noteTexture(value, color), curl, side: new THREE.MeshStandardMaterial({ color: new THREE.Color(color).lerp(new THREE.Color('#ece6d6'), 0.65), roughness: 0.9 }) };
  }, [value, color, l, w]);
  useEffect(() => () => [texture, curl, side].forEach((o) => o.dispose()), [texture, curl, side]);
  const rnd = useMemo(() => random(index + 11), [index]);
  const loose = useMemo(() => [0, 1].map(() => ({ dx: (rnd() - 0.5) * 0.004, dz: (rnd() - 0.5) * 0.006, ry: (rnd() - 0.5) * 0.08 })), [rnd]);
  return (
    <group position={[x, FLOOR, z]}>
      <mesh position={[0, stack / 2, 0]} material={side}>
        <boxGeometry args={[w, stack, l]} />
      </mesh>
      {loose.map((n, i) => (
        <mesh key={i} geometry={curl} position={[n.dx, stack + 0.0001 + i * 0.0003, n.dz]} rotation={[0, Math.PI / 2 + n.ry, 0]}>
          <meshStandardMaterial map={texture} roughness={0.85} side={THREE.DoubleSide} />
        </mesh>
      ))}
    </group>
  );
}

// ---- small parts ----

function canvasTexture(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  draw(canvas.getContext('2d')!);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

/** Soft shadow the open tray casts on the bench (the baked shadows only know the closed drawer). */
function TrayShadow() {
  const map = useMemo(() => canvasTexture(256, 256, (ctx) => {
    ctx.filter = 'blur(14px)';
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(34, 34, 188, 188);
  }), []);
  useEffect(() => () => map.dispose(), [map]);
  return (
    <mesh position={[0, 0.0004, (TRAY_BACK + PANEL_FRONT) / 2]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={1}>
      <planeGeometry args={[W + 0.02, PANEL_FRONT - TRAY_BACK + 0.02]} />
      <meshBasicMaterial map={map} transparent depthWrite={false} toneMapped={false} polygonOffset polygonOffsetFactor={-2} />
    </mesh>
  );
}

function Badge() {
  const map = useMemo(() => canvasTexture(512, 64, (ctx) => {
    ctx.fillStyle = 'rgba(205,210,218,0.5)';
    ctx.font = '700 40px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('P O S A N D B O X', 256, 46);
  }), []);
  useEffect(() => () => map.dispose(), [map]);
  return (
    <mesh position={[W / 2 - 0.06, 0.02, PANEL_FRONT + 0.0001]}>
      <planeGeometry args={[0.064, 0.008]} />
      <meshBasicMaterial map={map} transparent depthWrite={false} polygonOffset polygonOffsetFactor={-1} />
    </mesh>
  );
}

/** RJ12 cable from the printer's drawer-kick connector to the drawer, lying on the pad. */
function Cable() {
  const geometry = useMemo(() => {
    const [px, , pz] = printerPosition(0);
    const [dx, , dz] = drawerPosition();
    const rear = pz - PRINTER.depth / 2;
    const world = (x: number, y: number, z: number) => new THREE.Vector3(x - dx, y, z - dz);
    const side = -W / 2;
    const curve = new THREE.CatmullRomCurve3([
      world(px + 0.03, 0.02, rear - 0.006),
      world(px + 0.03, 0.011, rear - 0.016),
      world(px + 0.036, 0.0024, rear - 0.036),
      world(px + 0.075, 0.0022, rear - 0.046),
      new THREE.Vector3(side - 0.035, 0.0022, -0.12),
      new THREE.Vector3(side - 0.014, 0.0105, -0.12),
      new THREE.Vector3(side - 0.007, 0.014, -0.12),
    ]);
    return {
      tube: new THREE.TubeGeometry(curve, 80, 0.0018, 10),
      printerPlug: world(px + 0.03, 0.02, rear - 0.006),
    };
  }, []);
  useEffect(() => () => geometry.tube.dispose(), [geometry]);
  const plastic = <meshStandardMaterial color="#2c2d31" roughness={0.55} />;
  return (
    <group>
      <mesh geometry={geometry.tube} castShadow>
        <meshStandardMaterial color="#1a1b1d" roughness={0.62} />
      </mesh>
      <mesh position={geometry.printerPlug} castShadow>
        <boxGeometry args={[0.011, 0.009, 0.012]} />
        {plastic}
      </mesh>
      <mesh position={[-W / 2 - 0.007, 0.014, -0.12]} castShadow>
        <boxGeometry args={[0.014, 0.009, 0.011]} />
        {plastic}
      </mesh>
    </group>
  );
}

// ---- the drawer ----

const easeInOut = (p: number) => (p < 0.5 ? 4 * p ** 3 : 1 - (-2 * p + 2) ** 3 / 2);

/**
 * The cash drawer wired to `printer`. The engine owns the state (pin 3 of the kick connector); the tray only
 * animates towards it: a spring kick to the end stop with a small rebound on open, a hand push on close.
 */
export function DrawerStation({ printer, focused, onSelect }: { printer: PrinterSnapshot; focused: boolean; onSelect: () => void }) {
  const open = printer.status.drawerOpen;
  const id = printer.config.id;
  const geometry = useGeometry();
  const powder = usePowderCoat();
  const abs = usePlastic('#151618', 0.72);
  const tray = useRef<THREE.Group>(null);
  const middle = useRef<THREE.Group>(null);
  const motion = useRef({ x: open ? TRAVEL : 0, from: 0, t: Infinity, open });
  const [hover, setHover] = useState<'lock' | 'tray' | null>(null);
  const invalidate = useThree((s) => s.invalidate);

  useEffect(() => {
    const m = motion.current;
    if (m.open === open) return;
    motion.current = { ...m, from: m.x, t: 0, open };
    if (open) drawerSound.open(OPEN_TIME * (1 - m.x / TRAVEL));
    else drawerSound.close(CLOSE_TIME);
    invalidate();
  }, [open, invalidate]);

  useFrame(({ invalidate }, delta) => {
    const m = motion.current;
    if (m.t > (m.open ? OPEN_TIME + SETTLE : CLOSE_TIME)) return;
    m.t += Math.min(delta, MAX_STEP);
    if (m.open) {
      const p = Math.min(1, m.t / OPEN_TIME);
      const after = m.t - OPEN_TIME;
      m.x = after < 0 ? m.from + (TRAVEL - m.from) * (1 - (1 - p) ** 2) : TRAVEL - 0.007 * Math.exp(-9 * after) * Math.abs(Math.sin(22 * after));
    } else {
      m.x = m.from * (1 - easeInOut(Math.min(1, m.t / CLOSE_TIME)));
    }
    tray.current!.position.z = m.x;
    middle.current!.position.z = m.x / 2;
    invalidate();
  });

  const click = (part: 'lock' | 'tray') => (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    if (!focused) return onSelect();
    if (part === 'tray' && open) void api.setDrawer(id, false);
    if (part === 'lock' && !open) void api.setDrawer(id, true);
  };
  const actionable = (part: 'lock' | 'tray') => !focused || (part === 'tray' ? open : !open);
  const over = (part: 'lock' | 'tray') => (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    setHover(part);
    document.body.style.cursor = actionable(part) ? 'pointer' : '';
  };
  const out = () => {
    setHover(null);
    document.body.style.cursor = '';
  };

  return (
    <group>
      <group onClick={click('tray')} onPointerOver={over('tray')} onPointerOut={out}>
        <mesh geometry={geometry.housing} material={powder} castShadow receiveShadow />
        <mesh geometry={geometry.feet}>
          <meshStandardMaterial color="#0c0c0d" roughness={0.9} />
        </mesh>
        <mesh geometry={geometry.housingRails} material={METALS.rail} />
        <group ref={middle} position={[0, 0, motion.current.x / 2]}>
          <mesh geometry={geometry.middleRails} material={METALS.rail} />
        </group>

        <group ref={tray} position={[0, 0, motion.current.x]}>
          <TrayShadow />
          <mesh geometry={geometry.tray} material={powder} receiveShadow />
          <mesh geometry={geometry.trayRails} material={METALS.chrome} />
          <mesh geometry={geometry.insert} material={abs} receiveShadow />
          <mesh geometry={geometry.hinge} material={METALS.chrome} />
          {NOTES.map((_, i) => <NoteStack key={i} index={i} />)}
          <Coins />
          <Badge />
          <group position={[0, H - 0.026, PANEL_FRONT]} onClick={click('lock')} onPointerOver={over('lock')} onPointerOut={out}>
            <mesh geometry={geometry.lockBezel} material={METALS.chrome} />
            <mesh geometry={geometry.lockFace} material={METALS.nickel} />
            <mesh position={[0, 0, 0.0037]} rotation={[0, 0, open ? Math.PI / 2 : 0]}>
              <boxGeometry args={[0.0014, 0.0085, 0.0008]} />
              <meshBasicMaterial color="#050506" />
            </mesh>
          </group>
        </group>
      </group>
      <Cable />

      {hover && (!focused || actionable(hover)) && (
        <Html position={[0, H + 0.05, 0.05]} center zIndexRange={[10, 0]} className="scene-tip">
          <strong>Cash drawer</strong>
          <span className="scene-tip-row">
            <i className={`led led-${open ? 'warn' : 'ok'}`} />
            {open ? 'Open' : 'Closed'}
            <span className="scene-tip-sep">·</span>
            {printer.config.name}, pin 2
          </span>
          <span className="scene-tip-hint">
            {!focused ? 'Click to view' : hover === 'lock' ? 'Click: open with key' : 'Click: push to close'}
          </span>
        </Html>
      )}
    </group>
  );
}
