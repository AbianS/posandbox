import { test, type Page } from '@playwright/test';
import { connect } from 'node:net';
import { once } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';

// Opt-in benchmark of the panel: PERF=1 pnpm e2e. Writes e2e/artifacts/perf-<label>.json and prints a table.
test.skip(!process.env.PERF, 'set PERF=1 to run the benchmark');
test.setTimeout(240_000);

const LABEL = process.env.PERF_LABEL ?? 'run';
const SAMPLE = readFileSync(new URL('../fixtures/sample-ticket.bin', import.meta.url));

interface Window {
  __perf?: { frames: number; frameCpu: number[]; calls: number; triangles: number; textures: number; geometries: number; uploads: number; uploadMegapixels: number; uploadSizes: string[] };
  __bench?: { raf: number[]; longTasks: number[]; reset(): void };
}

/** rAF intervals (what the user perceives) and main-thread long tasks, from now on. */
async function instrument(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as Window;
    const bench = { raf: [] as number[], longTasks: [] as number[], reset() { this.raf.length = 0; this.longTasks.length = 0; if (w.__perf) { w.__perf.frameCpu.length = 0; w.__perf.frames = 0; w.__perf.uploads = 0; w.__perf.uploadMegapixels = 0; w.__perf.uploadSizes.length = 0; } } };
    let last = performance.now();
    const tick = (t: number) => { bench.raf.push(t - last); last = t; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    new PerformanceObserver((list) => list.getEntries().forEach((e) => bench.longTasks.push(e.duration))).observe({ type: 'longtask', buffered: false });
    w.__bench = bench;
  });
}

const stats = (xs: number[]) => {
  if (!xs.length) return { n: 0, avg: 0, p95: 0, max: 0 };
  const s = [...xs].sort((a, b) => a - b);
  return { n: xs.length, avg: +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1), p95: +s[Math.floor(s.length * 0.95)].toFixed(1), max: +s.at(-1)!.toFixed(1) };
};

async function measure(page: Page, run: () => Promise<void>) {
  await page.evaluate(() => (window as unknown as Window).__bench!.reset());
  const t0 = Date.now();
  await run();
  const data = await page.evaluate(() => {
    const w = window as unknown as Window;
    return { raf: w.__bench!.raf.slice(1), longTasks: w.__bench!.longTasks.slice(), frameCpu: w.__perf!.frameCpu.slice(), frames: w.__perf!.frames, uploads: w.__perf!.uploads, mpx: w.__perf!.uploadMegapixels, sizes: w.__perf!.uploadSizes.slice() };
  });
  return {
    seconds: +((Date.now() - t0) / 1000).toFixed(1),
    renderedFrames: data.frames,
    frameCpuMs: stats(data.frameCpu),
    frameIntervalMs: stats(data.raf),
    longTasks: { count: data.longTasks.length, totalMs: Math.round(data.longTasks.reduce((a, b) => a + b, 0)) },
    textureUploads: { count: data.uploads, megapixels: +data.mpx.toFixed(2), sizes: data.sizes },
  };
}

/** Time from a click until `done` is true in the page (polled each frame). */
async function latency(page: Page, click: () => Promise<void>, done: string) {
  await page.evaluate(() => ((window as unknown as { __t0: number }).__t0 = 0));
  const t = await Promise.all([
    page.evaluate((cond) => new Promise<number>((resolve) => {
      const start = performance.now();
      const check = () => (new Function(`return (${cond})`)() ? resolve(performance.now() - start) : requestAnimationFrame(check));
      check();
    }), done),
    click(),
  ]);
  return +t[0].toFixed(1);
}

test('benchmark', async ({ page }) => {
  await page.goto(`/?perf${process.env.PERF_FLAGS ? `&${process.env.PERF_FLAGS}` : ''}`);
  await page.getByRole('button', { name: 'Configure Receipt printer' }).waitFor();
  await page.waitForTimeout(4000); // assets, environment, first frames
  await instrument(page);
  const results: Record<string, unknown> = {};
  const box = (await page.locator('.stage').boundingBox())!;

  results.idle = await measure(page, () => page.waitForTimeout(2000));
  results.pointerParallax = await measure(page, async () => {
    for (let i = 0; i < 60; i++) await page.mouse.move(box.x + box.width * (0.2 + (i % 30) / 50), box.y + box.height * 0.5);
  });
  results.focusLatencyMs = await latency(page, () => page.getByRole('button', { name: 'Configure Receipt printer' }).click(),
    "document.querySelector('[aria-label=\"Device controls\"]') !== null");
  results.cameraTransition = await measure(page, () => page.waitForTimeout(2000));

  const tools = page.getByRole('toolbar', { name: /Tools for/ });
  const framesBefore = await page.evaluate(() => (window as unknown as Window).__perf!.frames);
  results.faultToUiLatencyMs = await latency(page, () => tools.getByRole('button', { name: 'Cover open' }).click(),
    "document.querySelector('.pill-warn') !== null");
  results.faultToSceneFrame = (await page.evaluate(() => (window as unknown as Window).__perf!.frames)) > framesBefore;
  {
    const cdpLid = await page.context().newCDPSession(page);
    await cdpLid.send('Profiler.enable');
    await cdpLid.send('Profiler.setSamplingInterval', { interval: 200 });
    await cdpLid.send('Profiler.start');
    results.lidAnimation = await measure(page, () => page.waitForTimeout(2500));
    const { profile } = (await cdpLid.send('Profiler.stop')) as { profile: { nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number } }[]; samples: number[]; timeDeltas: number[] } };
    const self = new Map<number, number>();
    profile.samples.forEach((id, i) => self.set(id, (self.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0)));
    const byFn = new Map<string, number>();
    for (const node of profile.nodes) {
      const ms = (self.get(node.id) ?? 0) / 1000;
      if (!ms) continue;
      const key = `${node.callFrame.functionName || '(anon)'} ${node.callFrame.url.split('/').pop()}:${node.callFrame.lineNumber}`;
      byFn.set(key, (byFn.get(key) ?? 0) + ms);
    }
    results.lidProfileTopSelfMs = [...byFn].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${v.toFixed(0)} ms  ${k}`);
  }
  await tools.getByRole('button', { name: 'Cover open' }).click();
  await page.waitForTimeout(1500);

  const socket = connect(Number(process.env.PRINTER_PORT ?? 9100), process.env.PRINTER_HOST ?? '127.0.0.1');
  await once(socket, 'connect');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
  await cdp.send('Profiler.start');
  results.printing = await measure(page, async () => {
    socket.write(SAMPLE);
    await page.waitForTimeout(6000);
  });
  const { profile } = (await cdp.send('Profiler.stop')) as { profile: { nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; hitCount?: number }[]; samples: number[]; timeDeltas: number[] } };
  // self time per function, top 15
  const self = new Map<number, number>();
  profile.samples.forEach((id, i) => self.set(id, (self.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0)));
  const byFn = new Map<string, number>();
  for (const node of profile.nodes) {
    const ms = (self.get(node.id) ?? 0) / 1000;
    if (!ms) continue;
    const f = node.callFrame;
    const key = `${f.functionName || '(anon)'} ${f.url.split('/').pop()}:${f.lineNumber}`;
    byFn.set(key, (byFn.get(key) ?? 0) + ms);
  }
  results.printingProfileTopSelfMs = [...byFn].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, v]) => `${v.toFixed(0)} ms  ${k}`);
  socket.destroy();
  await page.waitForTimeout(3000); // let the cut ticket settle
  await page.evaluate(() => { (window as unknown as { __perf: { invalidators: Record<string, number> } }).__perf.invalidators = {}; });
  results.idleAtEnd = await measure(page, () => page.waitForTimeout(3000));
  results.idleInvalidators = await page.evaluate(() => (window as unknown as { __perf: { invalidators: Record<string, number> } }).__perf.invalidators);
  results.renderer = await page.evaluate(() => {
    const p = (window as unknown as Window).__perf!;
    return { drawCalls: p.calls, triangles: p.triangles, textures: p.textures, geometries: p.geometries };
  });

  writeFileSync(`e2e/artifacts/perf-${LABEL}.json`, JSON.stringify(results, null, 2));
  console.log(`PERF ${LABEL} ${JSON.stringify(results)}`);
});
