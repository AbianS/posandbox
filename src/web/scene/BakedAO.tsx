import { useMemo } from 'react';
import type { ThreeElements } from '@react-three/fiber';
import * as THREE from 'three';
import { DESK, MAT, WALL_Z } from './bench.ts';

// Baked ambient occlusion for the static bench: soft darkening where surfaces meet (desk/wall corner,
// the pad's edge on the desk). Generated once as gradient textures on flat "decal" planes, so at runtime
// it costs a few textured quads — no screen-space pass. Screen-space AO (N8AO) stays for the printer.

function texture(draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void, w: number, h: number) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  draw(canvas.getContext('2d')!, w, h);
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Opacity falls off from one edge: a corner where light can't reach. */
const falloff = (strength: number) =>
  texture((ctx, w, h) => {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, `rgba(0,0,0,${strength})`);
    g.addColorStop(0.35, `rgba(0,0,0,${strength * 0.4})`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }, 4, 256);

/** A soft rounded-rectangle shadow: what a thin object lying on a surface does to it. */
function contactHalo(widthM: number, depthM: number, margin: number, strength: number) {
  const scale = 400; // px per metre
  const [w, h] = [Math.round((widthM + margin * 2) * scale), Math.round((depthM + margin * 2) * scale)];
  return texture((ctx) => {
    ctx.filter = `blur(${Math.round(margin * scale * 0.35)}px)`;
    ctx.fillStyle = `rgba(0,0,0,${strength})`;
    ctx.beginPath();
    ctx.roundRect(margin * scale, margin * scale, widthM * scale, depthM * scale, 6);
    ctx.fill();
  }, w, h);
}

function Decal({ map, size, ...mesh }: { map: THREE.Texture; size: [number, number] } & Omit<ThreeElements['mesh'], 'children'>) {
  return (
    <mesh {...mesh} renderOrder={1}>
      <planeGeometry args={size} />
      <meshBasicMaterial map={map} transparent depthWrite={false} toneMapped={false} polygonOffset polygonOffsetFactor={-2} />
    </mesh>
  );
}

export function BakedAO() {
  const maps = useMemo(() => {
    const margin = 0.05;
    return { corner: falloff(0.28), wall: falloff(0.22), pad: contactHalo(MAT.width, MAT.depth, margin, 0.5), margin };
  }, []);
  const deskBack = DESK.z - DESK.depth / 2;
  return (
    <group>
      {/* desk top along the wall: darkest at the wall */}
      <Decal map={maps.corner} size={[DESK.width, 0.1]} position={[0, 0.0003, Math.max(deskBack, WALL_Z) + 0.05]} rotation={[-Math.PI / 2, 0, 0]} />
      {/* bottom of the wall: darkest at the desk */}
      <Decal map={maps.wall} size={[5, 0.12]} position={[0, 0.06, WALL_Z + 0.0008]} rotation={[0, 0, Math.PI]} />
      {/* the pad's edge on the desk */}
      <Decal map={maps.pad} size={[MAT.width + maps.margin * 2, MAT.depth + maps.margin * 2]} position={[0, 0.0002, MAT.z]} rotation={[-Math.PI / 2, 0, 0]} />
    </group>
  );
}
