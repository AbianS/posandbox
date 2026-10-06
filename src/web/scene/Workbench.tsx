import { memo, useEffect, useMemo } from 'react';
import { useTexture } from '@react-three/drei';
import { RoundedBox } from '@react-three/drei';
import * as THREE from 'three';
import { DESK, MAT, padMarkings, WALL_Z } from './bench.ts';
import { BakedAO } from './BakedAO.tsx';

/**
 * Repeating PBR maps. Cloned once per (prefix, repeat): the deps are primitives on purpose — an array
 * literal here would re-clone (and re-upload to the GPU) 2K textures on every render.
 */
function useMaps(prefix: string, repeatX: number, repeatY: number) {
  const maps = useTexture([`/textures/${prefix}_diff.jpg`, `/textures/${prefix}_rough.jpg`, `/textures/${prefix}_nor_gl.jpg`]);
  const result = useMemo(() => {
    const [map, roughnessMap, normalMap] = maps.map((t) => {
      const c = t.clone();
      c.wrapS = c.wrapT = THREE.RepeatWrapping;
      c.repeat.set(repeatX, repeatY);
      c.anisotropy = 8;
      c.needsUpdate = true;
      return c;
    });
    map.colorSpace = THREE.SRGBColorSpace;
    return { map, roughnessMap, normalMap };
  }, [maps, repeatX, repeatY]);
  useEffect(() => () => Object.values(result).forEach((t) => t.dispose()), [result]);
  return result;
}

/** Oak desk against a plaster wall, with a dark leather desk pad where the devices sit. */
/** Memoised: the bench is static, lab events must not re-render it. */
export const Workbench = memo(function Workbench({ onBackgroundClick }: { onBackgroundClick: () => void }) {
  const oak = useMaps('wood', 3.5, 1);
  const wall = useMaps('wall', 5, 2.4);
  const pad = useMaps('pad', 2, 1);
  const markings = useMemo(padMarkings, []);
  const click = (e: { stopPropagation(): void }) => {
    e.stopPropagation();
    onBackgroundClick();
  };

  return (
    <group>
      {/* desk top: the surface is at y = 0 */}
      <mesh position={[0, -DESK.thickness / 2, DESK.z]} receiveShadow castShadow onClick={click}>
        <boxGeometry args={[DESK.width, DESK.thickness, DESK.depth]} />
        <meshStandardMaterial {...oak} normalScale={new THREE.Vector2(1.6, 1.6)} roughness={0.95} />
      </mesh>

      <mesh position={[0, 0.45, WALL_Z]} receiveShadow onClick={click}>
        <planeGeometry args={[5, 2.4]} />
        <meshStandardMaterial {...wall} color="#e9e6e0" normalScale={new THREE.Vector2(1.8, 1.8)} />
      </mesh>
      {/* desk pad */}
      <RoundedBox args={[MAT.width, MAT.thickness, MAT.depth]} radius={0.0015} smoothness={2} position={[0, MAT.thickness / 2, MAT.z]} receiveShadow onClick={click}>
        <meshStandardMaterial roughnessMap={pad.roughnessMap} normalMap={pad.normalMap} normalScale={new THREE.Vector2(0.9, 0.9)} color="#2a2c30" roughness={0.85} />
      </RoundedBox>
      <mesh position={[0, MAT.thickness + 0.0001, MAT.z]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[MAT.width, MAT.depth]} />
        <meshStandardMaterial map={markings} transparent depthWrite={false} roughness={0.8} />
      </mesh>
      <BakedAO />
    </group>
  );
});
