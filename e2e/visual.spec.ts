import { test } from '@playwright/test';
import { connect } from 'node:net';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';

// Opt-in frame captures of the print animation, for visual review: VISUAL=1 pnpm e2e
test.skip(!process.env.VISUAL, 'set VISUAL=1 to capture animation frames');

test.setTimeout(180_000);

test('captures the paper coming out, the cut and the ticket on the counter', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Configure Receipt printer' }).waitFor();
  await page.waitForTimeout(3000);
  const stage = page.locator('.stage');
  await stage.screenshot({ path: 'e2e/artifacts/visual-0-bench.png' });
  await page.getByRole('button', { name: 'Configure Receipt printer' }).click();
  await page.waitForTimeout(2500);
  await stage.screenshot({ path: 'e2e/artifacts/visual-0-focused.png' });

  // interior with the cover open (nothing printed yet): full roll, nearly empty, no paper
  const tools = page.getByRole('toolbar', { name: /Tools for/ });
  await page.getByRole('button', { name: 'Inside', exact: true }).click();
  await tools.getByRole('button', { name: 'Cover open' }).click();
  await page.waitForTimeout(3500);
  await stage.screenshot({ path: 'e2e/artifacts/visual-inside-full.png' });
  await tools.getByRole('button', { name: 'Paper low' }).click();
  await page.waitForTimeout(2000);
  await stage.screenshot({ path: 'e2e/artifacts/visual-inside-near-end.png' });
  await tools.getByRole('button', { name: 'Paper out' }).click();
  await page.waitForTimeout(2000);
  await stage.screenshot({ path: 'e2e/artifacts/visual-inside-empty.png' });
  for (const name of ['Paper out', 'Paper low', 'Cover open']) await tools.getByRole('button', { name }).click();
  await page.getByRole('button', { name: 'Printer', exact: true }).click();
  await page.waitForTimeout(2500);
  await stage.screenshot({ path: 'e2e/artifacts/visual-0-lit.png' });
  await page.getByRole('button', { name: 'Paper', exact: true }).click();
  await page.waitForTimeout(1500);

  const socket = connect(Number(process.env.PRINTER_PORT ?? 9100), process.env.PRINTER_HOST ?? '127.0.0.1');
  await once(socket, 'connect');
  socket.write(readFileSync(new URL('../fixtures/sample-ticket.bin', import.meta.url)));
  for (const ms of [600, 1500, 2500, 3000, 3000, 3000, 3000]) {
    await page.waitForTimeout(ms);
    await stage.screenshot({ path: `e2e/artifacts/visual-${Date.now()}.png` });
  }
  await page.getByRole('button', { name: 'Cut receipts' }).click();
  await page.waitForTimeout(2000);
  await stage.screenshot({ path: 'e2e/artifacts/visual-z-counter.png' });

  // a long ticket: curls back over the lid while printing
  await page.getByRole('button', { name: 'Printer', exact: true }).click();
  const lines = Array.from({ length: 70 }, (_, i) => `Línea ${String(i + 1).padStart(2, '0')} ........................ ${(i * 1.25).toFixed(2)}\n`).join('');
  socket.write(Buffer.concat([Buffer.from([0x1b, 0x40]), Buffer.from(lines, 'latin1'), Buffer.from([0x1d, 0x56, 0x01])]));
  for (const name of ['long-a', 'long-b', 'long-c', 'long-d']) {
    await page.waitForTimeout(3000);
    await stage.screenshot({ path: `e2e/artifacts/visual-${name}.png` });
  }

  socket.destroy();
});
