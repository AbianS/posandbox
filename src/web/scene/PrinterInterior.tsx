import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { PRINTER, SLOT } from './paper-path.ts';

// What you see with the top cover open: the paper bay with its cradle, the roll, the paper web up to the
// thermal head, the paper-end sensor; and, on the cover's underside, the platen roller and the ribs.

const BODY_TOP = PRINTER.bodyHeight;

/** Paper bay opening in the body (metres, printer space). */
export const BAY = { halfWidth: 0.047, rear: -0.057, front: 0.037, floor: 0.026 };
const ROLL_LENGTH = 0.081; // 80 mm paper on a slightly wider roll
const CRADLE = { radius: 0.042, y: BAY.floor + 0.042, z: -0.012 };

/** Footprint hole for the bay, in the shape coordinates used by the body extrusion (shape y = -z). */
export function bayHole(): THREE.Path {
  const { halfWidth: x, rear, front } = BAY;
  const r = 0.006;
  const [top, bottom] = [-rear, -front];
  const hole = new THREE.Path();
  hole.moveTo(-x + r, bottom);
  hole.lineTo(x - r, bottom);
  hole.quadraticCurveTo(x, bottom, x, bottom + r);
  hole.lineTo(x, top - r);
  hole.quadraticCurveTo(x, top, x - r, top);
  hole.lineTo(-x + r, top);
  hole.quadraticCurveTo(-x, top, -x, top - r);
  hole.lineTo(-x, bottom + r);
  hole.quadraticCurveTo(-x, bottom, -x + r, bottom);
  return hole;
}

/** Concentric paper layers and a cardboard core, for the faces of the roll. */
function rollFaceTexture(radius: number): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const c = size / 2;
  const core = (0.0125 / radius) * c; // 25 mm core
  ctx.fillStyle = '#f1efe9';
  ctx.beginPath();
  ctx.arc(c, c, c, 0, Math.PI * 2);
  ctx.fill();
  for (let r = core; r < c; r += 1.6 + Math.random() * 0.8) {
    ctx.strokeStyle = `rgba(150,145,135,${0.06 + Math.random() * 0.08})`;
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.arc(c, c, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.fillStyle = '#a78659';
  ctx.beginPath();
  ctx.arc(c, c, core, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#16120d';
  ctx.beginPath();
  ctx.arc(c, c, core * 0.82, 0, Math.PI * 2);
  ctx.fill();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

function PaperRoll({ radius }: { radius: number }) {
  const face = useMemo(() => rollFaceTexture(radius), [radius]);
  useEffect(() => () => face.dispose(), [face]);
  const y = BAY.floor + 0.0045 + radius; // resting on the bottom of the cradle
  return (
    <group position={[0, y, CRADLE.z]} rotation={[0, 0, Math.PI / 2]}>
      <mesh castShadow receiveShadow>
        <cylinderGeometry args={[radius, radius, ROLL_LENGTH, 72, 1, true]} />
        <meshPhysicalMaterial color="#f4f2ec" roughness={0.58} sheen={0.35} sheenColor="#ffffff" />
      </mesh>
      {[1, -1].map((side) => (
        <mesh key={side} position={[0, (side * ROLL_LENGTH) / 2, 0]} rotation={[(side * -Math.PI) / 2, 0, 0]}>
          <circleGeometry args={[radius, 72]} />
          <meshStandardMaterial map={face} roughness={0.8} />
        </mesh>
      ))}
    </group>
  );
}

/** The paper going from the top of the roll, over the thermal head, out of the slot. */
function PaperWeb({ radius }: { radius: number }) {
  const geometry = useMemo(() => {
    const rollY = BAY.floor + 0.0045 + radius;
    const curve = new THREE.CubicBezierCurve(
      new THREE.Vector2(CRADLE.z + radius * 0.35, rollY + radius * 0.94),
      new THREE.Vector2(CRADLE.z + radius * 1.1, rollY + radius * 1.2),
      new THREE.Vector2(SLOT.z - 0.004, BODY_TOP - 0.006),
      new THREE.Vector2(SLOT.z, SLOT.y - 0.0015),
    );
    const points = curve.getPoints(24);
    const positions: number[] = [];
    const index: number[] = [];
    points.forEach(({ x: z, y }, i) => {
      positions.push(-0.04, y, z, 0.04, y, z);
      if (i > 0) index.push(i * 2 - 2, i * 2 - 1, i * 2, i * 2 - 1, i * 2 + 1, i * 2);
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setIndex(index);
    g.computeVertexNormals();
    return g;
  }, [radius]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <mesh geometry={geometry} castShadow receiveShadow>
      <meshPhysicalMaterial color="#f2f0ea" roughness={0.5} side={THREE.DoubleSide} />
    </mesh>
  );
}

/** Body side of the mechanism: bay liner, cradle, thermal head, paper-end sensor and the paper itself. */
export function PrinterInterior({ rollRadius }: { rollRadius: number }) {
  const { halfWidth, rear, front, floor } = BAY;
  const depth = front - rear;
  const height = BODY_TOP - floor;
  const dark = <meshStandardMaterial color="#1a1b1e" roughness={0.85} side={THREE.BackSide} />;
  return (
    <group>
      {/* liner: the inside walls of the bay (back faces of a box, so its open top shows nothing) */}
      <mesh position={[0, floor + height / 2, (rear + front) / 2]} receiveShadow>
        <boxGeometry args={[halfWidth * 2 - 0.0006, height, depth - 0.0006]} />
        {dark}
      </mesh>
      {/* cradle the roll sits in */}
      <mesh position={[0, CRADLE.y, CRADLE.z]} rotation={[0, 0, Math.PI / 2]} receiveShadow>
        <cylinderGeometry args={[CRADLE.radius, CRADLE.radius, halfWidth * 2 - 0.002, 48, 1, true, Math.PI * 0.55, Math.PI * 0.9]} />
        <meshStandardMaterial color="#222327" roughness={0.7} side={THREE.BackSide} />
      </mesh>
      {/* ribs on the bay walls */}
      {[-1, 1].flatMap((side) =>
        [-0.04, -0.012, 0.016].map((z) => (
          <mesh key={`${side}${z}`} position={[side * (halfWidth - 0.0016), BODY_TOP - 0.022, z]} castShadow receiveShadow>
            <boxGeometry args={[0.0022, 0.036, 0.0018]} />
            <meshStandardMaterial color="#25262a" roughness={0.8} />
          </mesh>
        )),
      )}
      {/* thermal head: steel bracket with the ceramic heater line, under the slot */}
      <group position={[0, BODY_TOP - 0.004, front - 0.0035]}>
        <mesh castShadow receiveShadow>
          <boxGeometry args={[0.088, 0.006, 0.005]} />
          <meshPhysicalMaterial color="#9ea2a8" metalness={1} roughness={0.38} />
        </mesh>
        <mesh position={[0, 0.0031, 0]}>
          <boxGeometry args={[0.082, 0.0004, 0.0024]} />
          <meshStandardMaterial color="#2c2620" roughness={0.3} />
        </mesh>
      </group>
      {/* paper-end sensor: a small lever that drops when there is no paper */}
      <group position={[halfWidth - 0.012, floor + 0.006, CRADLE.z + 0.012]}>
        <mesh castShadow>
          <boxGeometry args={[0.009, 0.006, 0.008]} />
          <meshStandardMaterial color="#111114" roughness={0.5} />
        </mesh>
        <mesh position={[0, 0.004, rollRadius > 0 ? -0.001 : 0.002]} rotation={[rollRadius > 0 ? 0.6 : -0.2, 0, 0]}>
          <boxGeometry args={[0.0025, 0.0012, 0.009]} />
          <meshStandardMaterial color="#d9d4c8" roughness={0.6} />
        </mesh>
      </group>
      {rollRadius > 0 && <PaperRoll radius={rollRadius} />}
      {rollRadius > 0 && <PaperWeb radius={rollRadius} />}
    </group>
  );
}

/** Underside of the top cover: stiffening ribs and the black rubber platen roller at its front edge. */
export function CoverUnderside({ frontZ }: { frontZ: number }) {
  return (
    <group>
      {[-0.035, 0, 0.035].map((x) => (
        <mesh key={x} position={[x, BODY_TOP - 0.0015, (BAY.rear + frontZ) / 2]} castShadow>
          <boxGeometry args={[0.0018, 0.004, frontZ - BAY.rear - 0.01]} />
          <meshStandardMaterial color="#26272b" roughness={0.8} />
        </mesh>
      ))}
      <mesh position={[0, BODY_TOP - 0.003, frontZ - 0.0055]} rotation={[0, 0, Math.PI / 2]} castShadow>
        <cylinderGeometry args={[0.0058, 0.0058, 0.084, 40]} />
        <meshStandardMaterial color="#0d0d0e" roughness={0.55} />
      </mesh>
      {[-1, 1].map((side) => (
        <mesh key={side} position={[side * 0.0435, BODY_TOP - 0.003, frontZ - 0.0055]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.0025, 0.0025, 0.004, 20]} />
          <meshPhysicalMaterial color="#b0b3b8" metalness={1} roughness={0.3} />
        </mesh>
      ))}
    </group>
  );
}
