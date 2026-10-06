import { useEffect, useMemo, useRef } from 'react';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import { MAX_STEP, paperPath, surfaceHeight, type PrinterShape } from './paper-path.ts';
import { BLANK_PAPER, paperMaterialPatch, release } from './receipt-texture.ts';

export const SEGMENTS = 120;
const VERTS = (SEGMENTS + 1) * 2;

/** A ribbon of SEGMENTS rows × 2 columns. Front face (+normal) is the printed, thermal side. */
export function createStripGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(VERTS * 3), 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(VERTS * 2), 2));
  const index: number[] = [];
  for (let i = 0; i < SEGMENTS; i++) {
    const [l, r, l2, r2] = [i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 3];
    index.push(l, r, l2, r, r2, l2);
  }
  geometry.setIndex(index);
  return geometry;
}

/** Writes a centre line ([z, y] pairs from the slot to the tip) and the texture rows into the strip. */
export function layoutStrip(geometry: THREE.BufferGeometry, path: Float32Array, width: number, v: (i: number) => number, span = 1): void {
  const [u0, u1] = [0.5 - span / 2, 0.5 + span / 2]; // the image covers the printable area only
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  const uv = geometry.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i <= SEGMENTS; i++) {
    const [z, y] = [path[i * 2], path[i * 2 + 1]];
    position.setXYZ(i * 2, -width / 2, y, z);
    position.setXYZ(i * 2 + 1, width / 2, y, z);
    uv.setXY(i * 2, u0, v(i));
    uv.setXY(i * 2 + 1, u1, v(i));
  }
  position.needsUpdate = true;
  uv.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
}

const pathBuffer = new Float32Array((SEGMENTS + 1) * 2);

interface StripProps {
  geometry: THREE.BufferGeometry;
  /** Current length out of the slot, in metres (read every frame). */
  length: () => number;
  /** Height of the texture image, in metres. */
  imageLength: number;
  texture: THREE.Texture | null;
  width: number;
  shape: PrinterShape;
  /** Paper width / printable width: UVs beyond the printed area are margins. */
  span: number;
  onClick: (e: ThreeEvent<MouseEvent>) => void;
}

/** The paper coming out of the printer: deformed every frame from the paper path model. */
export function PaperStrip({ geometry, length, imageLength, texture, width, shape, span, onClick }: StripProps) {
  const last = useRef(-1);
  const group = useRef<THREE.Group>(null);

  useFrame(() => {
    const L = length();
    if (group.current) group.current.visible = L > 0.0005;
    if (Math.abs(L - last.current) < 1e-6 && last.current >= 0) return;
    last.current = L;
    paperPath(L, SEGMENTS, pathBuffer, shape);
    // tip = top of the ticket (image row 0, v = 1); the slot shows the newest printed row
    layoutStrip(geometry, pathBuffer, width, (i) => 1 - (L - (i / SEGMENTS) * L) / Math.max(imageLength, 1e-6), span);
  });

  useEffect(() => {
    last.current = -1; // re-layout with the new image
  }, [imageLength, texture, shape, span]);

  return (
    <group ref={group}>
      <Paper geometry={geometry} texture={texture} onClick={onClick} />
    </group>
  );
}

export function Paper({ geometry, texture, onClick }: { geometry: THREE.BufferGeometry; texture: THREE.Texture | null; onClick?: (e: ThreeEvent<MouseEvent>) => void }) {
  const handlers = onClick && {
    onClick,
    onPointerOver: (e: ThreeEvent<PointerEvent>) => {
      e.stopPropagation();
      document.body.style.cursor = 'zoom-in';
    },
    onPointerOut: () => {
      document.body.style.cursor = '';
    },
  };
  return (
    <>
      <mesh geometry={geometry} receiveShadow frustumCulled={false} {...handlers}>
        {/* always a map (placeholder until the image loads): the shader never has to recompile */}
        <meshStandardMaterial map={texture ?? BLANK_PAPER} color="#f6f4ee" roughness={0.55} side={THREE.FrontSide} onBeforeCompile={paperMaterialPatch} />
      </mesh>
      <mesh geometry={geometry} receiveShadow frustumCulled={false}>
        <meshStandardMaterial color="#efece4" roughness={0.7} side={THREE.BackSide} />
      </mesh>
    </>
  );
}

/** Where the k-th most recent ticket lies on the pad, in front of the printer. */
function restLayout(length: number, width: number, k: number, out: Float32Array, shape: PrinterShape): void {
  const zStart = shape.depth / 2 + 0.03 + k * 0.006;
  const yaw = (k % 2 ? 1 : -1) * 0.05 * k - 0.04;
  const x0 = 0.01 - k * 0.018;
  const y = 0.0007 + (4 - k) * 0.0005;
  const cz = zStart + length / 2;
  const [c, s] = [Math.cos(yaw), Math.sin(yaw)];
  for (let i = 0; i <= SEGMENTS; i++) {
    const z = zStart + length - (i / SEGMENTS) * length; // tip (top of the ticket) nearest the printer
    for (const side of [0, 1]) {
      const x = (side ? 1 : -1) * (width / 2);
      const dz = z - cz;
      const o = (i * 2 + side) * 3;
      out[o] = x0 + x * c + dz * s;
      out[o + 1] = y;
      out[o + 2] = cz - x * s + dz * c;
    }
  }
}

export interface LooseTicket {
  key: string;
  length: number;
  texture: THREE.Texture | null;
  /** Shape at the moment of the cut (absent for tickets that were already on the pad). */
  from?: Float32Array;
}

/**
 * A cut ticket: glides from where it was cut down to the pad in front of the printer, printed side up;
 * older tickets slide to make room. Every point of the paper is kept above the printer's surfaces on
 * the way, so it slides over the printer instead of crossing it.
 */
export function CounterTicket({ ticket, texture, index, width, shape, span, onClick }: {
  ticket: LooseTicket;
  texture: THREE.Texture | null;
  index: number;
  width: number;
  shape: PrinterShape;
  span: number;
  onClick: () => void;
}) {
  const geometry = useMemo(() => {
    const g = createStripGeometry();
    const uv = g.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i <= SEGMENTS; i++) {
      uv.setXY(i * 2, 0.5 - span / 2, i / SEGMENTS);
      uv.setXY(i * 2 + 1, 0.5 + span / 2, i / SEGMENTS);
    }
    return g;
  }, [span]);
  useEffect(() => () => release(texture), [texture]);
  const target = useMemo(() => new Float32Array(VERTS * 3), []);
  const group = useRef<THREE.Group>(null);
  const age = useRef(ticket.from ? 0 : 10);
  const initial = useRef({ ticket, index });

  useEffect(() => {
    const { ticket: t, index: k } = initial.current;
    restLayout(t.length, width, k, target, shape);
    const position = geometry.getAttribute('position') as THREE.BufferAttribute;
    (position.array as Float32Array).set(t.from ?? target);
    position.needsUpdate = true;
    geometry.computeVertexNormals();
    return () => geometry.dispose();
    // created once per ticket: later moves are animated in useFrame
  }, [geometry]);

  useFrame(({ invalidate }, delta) => {
    const dt = Math.min(delta, MAX_STEP);
    restLayout(ticket.length, width, index, target, shape);
    const position = geometry.getAttribute('position') as THREE.BufferAttribute;
    const array = position.array as Float32Array;
    age.current += dt;
    const lift = age.current < 0.9 ? Math.sin((age.current / 0.9) * Math.PI) * 0.045 : 0;
    let moving = lift > 0;
    for (let i = 0; i < array.length; i++) {
      const goal = target[i] + (i % 3 === 1 ? lift : 0);
      const next = THREE.MathUtils.damp(array[i], goal, 5, dt);
      if (Math.abs(next - goal) > 1e-5) moving = true;
      array[i] = next;
    }
    if (!moving) return;
    // over the printer, never through it
    for (let v = 0; v < array.length; v += 3) {
      if (Math.abs(array[v]) < shape.width / 2 + 0.004 && Math.abs(array[v + 2]) < shape.depth / 2 + 0.004) {
        array[v + 1] = Math.max(array[v + 1], surfaceHeight(array[v + 2], shape) + 0.001);
      }
    }
    position.needsUpdate = true;
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    invalidate();
  });

  return (
    <group ref={group}>
      <Paper geometry={geometry} texture={texture} onClick={(e) => { e.stopPropagation(); onClick(); }} />
    </group>
  );
}
