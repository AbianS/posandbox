import { useEffect, useState } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';

export const DOTS_PER_M = 8000; // 203 dpi ≈ 8 dots/mm
const PAPER_DOTS = { 80: 640, 58: 464 } as const;

export interface ReceiptTexture {
  texture: THREE.Texture;
  /** Height of the printed image, in dots. */
  heightDots: number;
  /** Which image this is (URL without query): lets callers tell a stale image from the current source. */
  source: string;
}

/** 1×1 white texture: materials always have a map, so they never recompile when one arrives. */
export const BLANK_PAPER = (() => {
  const t = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
})();

/** Horizontal UV span of the printed area within the paper width (the rest is blank margin). */
export function printableSpan(paperWidth: 80 | 58): number {
  return PAPER_DOTS[paperWidth] / { 80: 576, 58: 420 }[paperWidth];
}

/**
 * Loads a ticket PNG straight into a GPU texture: decoded off the main thread into an ImageBitmap, which
 * the browser uploads on its fast path (no intermediate canvas, native resolution). Margins and the paper
 * tint are done by the material (see paperMaterialPatch), not baked into pixels.
 */
export function useReceiptTexture(url: string | null): ReceiptTexture | null {
  const gl = useThree((s) => s.gl);
  const [state, setState] = useState<ReceiptTexture | null>(null);

  useEffect(() => {
    if (!url) {
      setState(null);
      return;
    }
    const controller = new AbortController();
    fetch(url, { signal: controller.signal })
      .then((res) => res.blob())
      .then((blob) => createImageBitmap(blob, { imageOrientation: 'flipY' }))
      .then((image) => {
        if (controller.signal.aborted) return image.close();
        const texture = new THREE.Texture(image);
        texture.flipY = false; // already flipped by createImageBitmap (WebGL ignores flipY for bitmaps)
        // linear: the ticket is pure black/white (identical in sRGB), and it skips the sRGB conversion on upload
        texture.colorSpace = THREE.NoColorSpace;
        texture.anisotropy = Math.min(8, gl.capabilities.getMaxAnisotropy());
        texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
        texture.needsUpdate = true;
        setState({ texture, heightDots: image.height, source: url.split('?')[0] });
      })
      .catch(() => undefined); // aborted or failed: keep the previous image
    return () => controller.abort();
  }, [url, gl]);

  useEffect(
    () => () => {
      // a texture handed to a cut ticket (userData.adopted) now belongs to that ticket
      if (!state || state.texture.userData.adopted) return;
      state.texture.dispose();
      (state.texture.image as ImageBitmap | undefined)?.close?.();
    },
    [state],
  );
  return url ? state : null;
}

/** Hands a texture over to its new owner (a cut ticket), which disposes it when it goes away. */
export function adopt(texture: THREE.Texture): THREE.Texture {
  texture.userData.adopted = true;
  return texture;
}

export function release(texture: THREE.Texture | null): void {
  if (!texture?.userData.adopted) return;
  texture.dispose();
  (texture.image as ImageBitmap | undefined)?.close?.();
}

/** Shader patch for paper: UVs outside the printed area (the margins) show plain paper, not stretched ink. */
export function paperMaterialPatch(shader: { fragmentShader: string }): void {
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <map_fragment>',
    `#ifdef USE_MAP
      vec4 sampledDiffuseColor = (vMapUv.x < 0.0 || vMapUv.x > 1.0) ? vec4(1.0) : texture2D(map, vMapUv);
      diffuseColor *= sampledDiffuseColor;
    #endif`,
  );
}
