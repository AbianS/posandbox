import { useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { MAX_STEP } from './paper-path.ts';

export interface CameraPose {
  position: [number, number, number];
  target: [number, number, number];
}

/** Guided camera: no free orbit. It glides to the requested pose; nothing renders while it stands still. */
export function CameraRig({ pose }: { pose: CameraPose }) {
  const camera = useThree((s) => s.camera);
  const look = useRef(new THREE.Vector3(...pose.target));
  const goal = new THREE.Vector3();

  useFrame(({ invalidate }, delta) => {
    const dt = Math.min(delta, MAX_STEP);
    goal.set(...pose.position);
    const before = camera.position.clone();
    camera.position.x = THREE.MathUtils.damp(camera.position.x, goal.x, 4, dt);
    camera.position.y = THREE.MathUtils.damp(camera.position.y, goal.y, 4, dt);
    camera.position.z = THREE.MathUtils.damp(camera.position.z, goal.z, 4, dt);
    const lookBefore = look.current.clone();
    look.current.x = THREE.MathUtils.damp(look.current.x, pose.target[0], 4, dt);
    look.current.y = THREE.MathUtils.damp(look.current.y, pose.target[1], 4, dt);
    look.current.z = THREE.MathUtils.damp(look.current.z, pose.target[2], 4, dt);
    camera.lookAt(look.current);
    // settle threshold ~0.1 mm: below that further frames are invisible
    if (before.distanceToSquared(camera.position) > 1e-8 || lookBefore.distanceToSquared(look.current) > 1e-8) invalidate();
  });
  return null;
}
