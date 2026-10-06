import { useFrame, useThree } from '@react-three/fiber';
import { useEffect } from 'react';

/**
 * Only with `?perf` in the URL: exposes what the renderer does so a benchmark can measure it
 * (rendered frames and their CPU time, draw calls). Nothing is mounted otherwise.
 */
const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
export const PERF_ENABLED = params.has('perf');
/** Benchmark switches (only with ?perf): turn individual effects off to measure what they cost. */
export const PERF_FLAGS = {
  noAo: PERF_ENABLED && params.has('noao'),
  noSmaa: PERF_ENABLED && params.has('nosmaa'),
  noFx: PERF_ENABLED && params.has('nofx'),
  aoQuality: (PERF_ENABLED && params.get('aoq')) || null,
};

declare global {
  interface Window {
    __perf?: {
      frames: number; frameCpu: number[]; calls: number; triangles: number; textures: number; geometries: number;
      /** Texture uploads (texImage2D/texSubImage2D) and the megapixels they moved: GPU-independent cost. */
      uploads: number; uploadMegapixels: number; uploadSizes: string[];
      /** Who requests frames: caller location → count (to find renders nobody needs). */
      invalidators: Record<string, number>;
    };
  }
}

export function PerfProbe() {
  const gl = useThree((s) => s.gl);
  const set = useThree((s) => s.set);
  const get = useThree((s) => s.get);
  useEffect(() => {
    const perf = (window.__perf = { frames: 0, frameCpu: [], calls: 0, triangles: 0, textures: 0, geometries: 0, uploads: 0, uploadMegapixels: 0, uploadSizes: [] as string[], invalidators: {} as Record<string, number> });
    // record who calls invalidate (the store's function, used by useFrame callbacks)
    const original = get().invalidate;
    set({
      invalidate: (...args: Parameters<typeof original>) => {
        const caller = (new Error().stack ?? '').split('\n')[2]?.trim().replace(/\(?https?:\/\/[^/]+\/assets\//, '') ?? '?';
        perf.invalidators[caller] = (perf.invalidators[caller] ?? 0) + 1;
        return original(...args);
      },
    });
    // count texture uploads: wrap the context's upload calls (perf mode only)
    const ctx = gl.getContext() as WebGL2RenderingContext;
    for (const name of ['texImage2D', 'texSubImage2D'] as const) {
      const original = ctx[name].bind(ctx) as (...args: unknown[]) => void;
      (ctx as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
        const source = args.find((a) => a && typeof a === 'object' && 'width' in (a as object)) as { width: number; height: number } | undefined;
        const [w, h] = source ? [source.width, source.height] : [Number(args[name === 'texImage2D' ? 3 : 4]) || 0, Number(args[name === 'texImage2D' ? 4 : 5]) || 0];
        perf.uploads++;
        perf.uploadSizes.push(`${name} ${w}x${h} ${source ? source.constructor.name : 'null'}`);
        perf.uploadMegapixels += (w * h) / 1e6;
        original(...args);
      };
    }
  }, [gl, set, get]);
  // runs first in every rendered frame; the whole frame (callbacks + render) is one task, so a microtask
  // queued here runs right after it: the difference is the frame's main-thread cost
  useFrame(() => {
    const perf = window.__perf;
    if (!perf) return;
    const start = performance.now();
    perf.frames++;
    queueMicrotask(() => perf.frameCpu.push(performance.now() - start));
    perf.calls = gl.info.render.calls;
    perf.triangles = gl.info.render.triangles;
    perf.textures = gl.info.memory.textures;
    perf.geometries = gl.info.memory.geometries;
  }, -1000);
  return null;
}
