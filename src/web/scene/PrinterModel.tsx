import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { useTexture } from '@react-three/drei';
import * as THREE from 'three';
import { MAX_STEP, PRINTER, SLOT } from './paper-path.ts';
import { bayHole, CoverUnderside, PrinterInterior } from './PrinterInterior.tsx';

export interface PrinterLook {
  powered: boolean;
  lidOpen: boolean;
  error: 'off' | 'on' | 'blink';
  paperLed: boolean;
  /** Roll radius in metres; 0 = no paper. */
  rollRadius: number;
}

// Modern cube receipt printer (TSP100 / TM-m30 class), 127 × 127 × 131 mm. Origin: base centre, +z = front.
const W = PRINTER.width;
const D = PRINTER.depth;
const H = PRINTER.height;
const BODY_TOP = PRINTER.bodyHeight;
const R = 0.016; // vertical corner radius
const GAP = 0.0007; // parting line between cover, lip and body
const LID_FRONT = SLOT.z - 0.004;
const LIP_BACK = SLOT.z + 0.004;
const HINGE = { y: BODY_TOP + 0.006, z: -D / 2 + 0.004 };

/** Rounded rectangle footprint in the XZ plane (shape y = -z). Radii: rear-left, rear-right, front-right, front-left. */
export function footprint(x0: number, z0: number, x1: number, z1: number, [rl, rr, fr, fl]: number[]): THREE.Shape {
  const s = new THREE.Shape();
  const [a, b, c, d] = [-z0, -z1, x0, x1]; // shape y: rear (z0) is up
  s.moveTo(c + fl, b);
  s.lineTo(d - fr, b);
  s.quadraticCurveTo(d, b, d, b + fr);
  s.lineTo(d, a - rr);
  s.quadraticCurveTo(d, a, d - rr, a);
  s.lineTo(c + rl, a);
  s.quadraticCurveTo(c, a, c, a - rl);
  s.lineTo(c, b + fl);
  s.quadraticCurveTo(c, b, c + fl, b);
  return s;
}

/** The body is a shell: the paper bay is cut out of its footprint. */
function withBay(shape: THREE.Shape): THREE.Shape {
  shape.holes.push(bayHole());
  return shape;
}

/** Extrudes a footprint between two heights with rounded (beveled) edges, keeping the outline exact. */
export function slab(shape: THREE.Shape, y0: number, y1: number, bevel: number): THREE.BufferGeometry {
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: y1 - y0 - 2 * bevel, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelOffset: -bevel,
    bevelSegments: 5, curveSegments: 20,
  });
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, y0 + bevel, 0);
  geometry.computeVertexNormals();
  return geometry;
}

/** Textured ABS: matte, fine grain, no clearcoat (that is car paint, not a printer). */
export function usePlastic(color: string, roughness: number) {
  const normal = useTexture('/textures/plastic_nor_gl.jpg');
  return useMemo(() => {
    const grain = normal.clone();
    grain.wrapS = grain.wrapT = THREE.RepeatWrapping;
    grain.repeat.set(110, 110); // extrude UVs are in metres: one tile ≈ 9 mm, a fine even texture
    grain.anisotropy = 8;
    grain.needsUpdate = true;
    // uniform roughness: a roughness map at this scale reads as blotches, real textured ABS is even
    return new THREE.MeshStandardMaterial({ color, roughness, normalMap: grain, normalScale: new THREE.Vector2(0.12, 0.12), envMapIntensity: 0.75 });
  }, [normal, color, roughness]);
}

type IconKind = 'power' | 'error' | 'paper' | 'feed';

/** One printed icon (light grey on the plastic), drawn once per kind. */
function useIcon(kind: IconKind) {
  return useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 128;
    const ctx = canvas.getContext('2d')!;
    ctx.strokeStyle = ctx.fillStyle = 'rgba(205,210,218,0.85)';
    ctx.lineWidth = 9;
    ctx.lineCap = 'round';
    ctx.beginPath();
    if (kind === 'power') {
      ctx.arc(64, 68, 34, -Math.PI / 2 + 0.6, Math.PI * 1.5 - 0.6);
      ctx.moveTo(64, 22);
      ctx.lineTo(64, 64);
      ctx.stroke();
    } else if (kind === 'error') {
      ctx.moveTo(64, 22);
      ctx.lineTo(64, 78);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(64, 102, 7, 0, Math.PI * 2);
      ctx.fill();
    } else if (kind === 'paper') {
      ctx.arc(64, 64, 34, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(64, 64, 10, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.moveTo(64, 96);
      ctx.lineTo(64, 26);
      ctx.moveTo(38, 52);
      ctx.lineTo(64, 26);
      ctx.lineTo(90, 52);
      ctx.moveTo(30, 110);
      ctx.lineTo(98, 110);
      ctx.stroke();
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 8;
    return texture;
  }, [kind]);
}

function Icon({ kind, position, size }: { kind: IconKind; position: [number, number, number]; size: number }) {
  const map = useIcon(kind);
  return (
    <mesh position={position} rotation={[-Math.PI / 2, 0, 0]}>
      <planeGeometry args={[size, size]} />
      <meshBasicMaterial map={map} transparent depthWrite={false} toneMapped={false} polygonOffset polygonOffsetFactor={-1} />
    </mesh>
  );
}

/** Status lights on the front lip: each LED with its printed icon just to its left. */
const INDICATORS: { kind: IconKind; x: number; color: string }[] = [
  { kind: 'power', x: 0.02, color: '#40ff86' },
  { kind: 'error', x: 0.033, color: '#ff8a1f' },
  { kind: 'paper', x: 0.046, color: '#ff8a1f' },
];

function Led({ position, color, on, blink }: { position: [number, number, number]; color: string; on: boolean; blink?: boolean }) {
  const material = useRef<THREE.MeshPhysicalMaterial>(null);
  const invalidate = useThree((s) => s.invalidate);
  // blink on a timer (2.5 frames/s) instead of rendering every frame
  useEffect(() => {
    if (!on || !blink) return;
    let lit = true;
    const timer = setInterval(() => {
      lit = !lit;
      if (material.current) material.current.emissiveIntensity = lit ? 3.5 : 0;
      invalidate();
    }, 400);
    return () => clearInterval(timer);
  }, [on, blink, invalidate]);
  return (
    <mesh position={position} rotation={[-Math.PI / 2, 0, 0]}>
      <circleGeometry args={[0.0016, 32]} />
      <meshPhysicalMaterial ref={material} color={on ? color : '#24262a'} emissive={color} emissiveIntensity={on ? 3.5 : 0} roughness={0.15} clearcoat={1} toneMapped={false} />
    </mesh>
  );
}

function FeedButton({ position, onPress, children }: { position: [number, number, number]; onPress: () => void; children?: React.ReactNode }) {
  const [pressed, setPressed] = useState(false);
  const geometry = useMemo(() => slab(footprint(-0.009, -0.0045, 0.009, 0.0045, [0.0045, 0.0045, 0.0045, 0.0045]), 0, 0.0016, 0.0006), []);
  const release = () => {
    setPressed(false);
    document.body.style.cursor = '';
  };
  return (
    <mesh
      geometry={geometry}
      position={[position[0], position[1] - (pressed ? 0.0009 : 0), position[2]]}
      castShadow
      onPointerDown={(e) => {
        e.stopPropagation();
        setPressed(true);
        onPress();
      }}
      onPointerUp={release}
      onPointerOver={(e) => {
        e.stopPropagation();
        document.body.style.cursor = 'pointer';
      }}
      onPointerOut={release}
    >
      <meshPhysicalMaterial color="#3a3c42" roughness={0.38} clearcoat={0.5} clearcoatRoughness={0.3} />
      {children}
    </mesh>
  );
}

/** Serrated tear bar along the front edge of the slot (instanced teeth). */
function TearBar() {
  const teeth = useRef<THREE.InstancedMesh>(null);
  const width = W - 0.03;
  const count = Math.floor(width / 0.0021);
  useLayoutEffect(() => {
    const m = new THREE.Matrix4();
    for (let i = 0; i < count; i++) {
      m.makeRotationX(0.35).setPosition(-width / 2 + (i + 0.5) * (width / count), BODY_TOP + 0.0155, LIP_BACK + 0.0003);
      teeth.current!.setMatrixAt(i, m);
    }
    teeth.current!.instanceMatrix.needsUpdate = true;
  }, [count, width]);
  const metal = <meshPhysicalMaterial color="#b9bcc2" metalness={1} roughness={0.32} />;
  return (
    <group>
      <mesh position={[0, BODY_TOP + 0.0118, LIP_BACK + 0.0003]} castShadow>
        <boxGeometry args={[width, 0.0062, 0.0008]} />
        {metal}
      </mesh>
      <instancedMesh ref={teeth} args={[undefined, undefined, count]} castShadow>
        <coneGeometry args={[0.0008, 0.0016, 4]} />
        {metal}
      </instancedMesh>
    </group>
  );
}

/** Procedural modern receipt printer: rounded body, hinged top cover, front lip with tear bar, LEDs and buttons. */
export function PrinterModel({ look, onFeed }: { look: PrinterLook; onFeed: () => void }) {
  const body = usePlastic('#2b2c30', 0.78);
  const cover = usePlastic('#303136', 0.68);
  const lipMaterial = usePlastic('#242529', 0.74);
  const lid = useRef<THREE.Group>(null);

  const geometry = useMemo(() => {
    const x = W / 2;
    return {
      plinth: slab(footprint(-x + 0.005, -D / 2 + 0.005, x - 0.005, D / 2 - 0.005, [R - 0.005, R - 0.005, R - 0.005, R - 0.005]), 0, 0.006, 0.0015),
      body: slab(withBay(footprint(-x, -D / 2, x, D / 2, [R, R, R, R])), 0.005, BODY_TOP, 0.0025),
      core: slab(withBay(footprint(-x + 0.004, -D / 2 + 0.004, x - 0.004, D / 2 - 0.004, [R - 0.004, R - 0.004, R - 0.004, R - 0.004])), BODY_TOP - 0.002, H - 0.003, 0),
      cover: slab(footprint(-x + GAP, -D / 2 + GAP, x - GAP, LID_FRONT, [R - GAP, R - GAP, 0.0045, 0.0045]), BODY_TOP + GAP, H, 0.003), // corner radius > bevel: no folded spikes
      lip: slab(footprint(-x + GAP, LIP_BACK, x - GAP, D / 2 - GAP, [0.0045, 0.0045, R - GAP, R - GAP]), BODY_TOP + GAP, H - 0.0005, 0.003),
      powerRing: new THREE.TorusGeometry(0.0052, 0.0007, 12, 48),
    };
  }, []);
  useLayoutEffect(() => () => Object.values(geometry).forEach((g) => g.dispose()), [geometry]);

  useFrame(({ invalidate }, delta) => {
    if (!lid.current) return;
    const target = look.lidOpen ? -1.65 : 0;
    const current = lid.current.rotation.x;
    if (Math.abs(target - current) < 1e-3) return;
    lid.current.rotation.x = THREE.MathUtils.damp(current, target, 6, Math.min(delta, MAX_STEP));
    invalidate();
  });

  const lipTop = H - 0.0005 + 0.0001;
  const lipZ = (LIP_BACK + D / 2) / 2 + 0.002;

  return (
    <group>
      <mesh geometry={geometry.plinth} castShadow receiveShadow>
        <meshStandardMaterial color="#121214" roughness={0.9} />
      </mesh>
      <mesh geometry={geometry.body} material={body} castShadow receiveShadow />
      {/* dark core: what you see through the parting lines and the slot */}
      <mesh geometry={geometry.core}>
        <meshStandardMaterial color="#060607" roughness={1} />
      </mesh>

      {/* mechanism and paper, seen with the cover open */}
      <PrinterInterior rollRadius={look.rollRadius} />

      <group ref={lid} position={[0, HINGE.y, HINGE.z]}>
        <group position={[0, -HINGE.y, -HINGE.z]}>
          <mesh geometry={geometry.cover} material={cover} castShadow receiveShadow />
          <CoverUnderside frontZ={LID_FRONT} />
        </group>
      </group>

      <mesh geometry={geometry.lip} material={lipMaterial} castShadow receiveShadow />
      {/* slot ends: the casing closes the slot at both sides, so it is only as wide as the paper */}
      {[-1, 1].map((side) => {
        const inner = 0.0445;
        const outer = W / 2 - GAP - 0.003;
        return (
          <mesh key={side} material={lipMaterial} position={[side * (inner + outer) / 2, (BODY_TOP + H) / 2 - 0.0005, (LID_FRONT + LIP_BACK) / 2]} castShadow receiveShadow>
            <boxGeometry args={[outer - inner, H - BODY_TOP - 0.001, LIP_BACK - LID_FRONT + 0.001]} />
          </mesh>
        );
      })}
      <TearBar />

      {/* status LEDs and FEED button on the front lip */}
      {INDICATORS.map(({ kind, x, color }) => (
        <group key={kind}>
          <Icon kind={kind} position={[x - 0.0056, lipTop + 0.00005, lipZ]} size={0.0042} />
          <Led
            position={[x, lipTop, lipZ]}
            color={color}
            on={look.powered && (kind === 'power' || (kind === 'error' ? look.error !== 'off' : look.paperLed))}
            blink={kind === 'error' && look.error === 'blink'}
          />
        </group>
      ))}
      <FeedButton position={[-0.03, lipTop - 0.0001, lipZ]} onPress={onFeed}>
        <Icon kind="feed" position={[0, 0.00165, 0]} size={0.0055} />
      </FeedButton>

      {/* power button with light ring on the front face */}
      <group position={[-W / 2 + 0.018, 0.022, D / 2 + 0.0002]}>
        <mesh rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[0.0045, 0.0045, 0.0018, 40]} />
          <meshPhysicalMaterial color="#1c1d20" roughness={0.4} clearcoat={0.6} />
        </mesh>
        <mesh geometry={geometry.powerRing}>
          <meshStandardMaterial color={look.powered ? '#bfe9ff' : '#2a2c30'} emissive="#7fd3ff" emissiveIntensity={look.powered ? 1.6 : 0} toneMapped={false} />
        </mesh>
      </group>
    </group>
  );
}
