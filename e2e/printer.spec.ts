import { test, expect, type Page } from '@playwright/test';
import { connect, type Socket } from 'node:net';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';

const HOST = process.env.PRINTER_HOST ?? '127.0.0.1';
const PORT = Number(process.env.PRINTER_PORT ?? 9100);
const SAMPLE = readFileSync(new URL('../fixtures/sample-ticket.bin', import.meta.url));
const DLE_EOT = (n: number) => Buffer.from([0x10, 0x04, n]);

test.describe.configure({ mode: 'serial' });

/** A minimal POS: raw TCP, like any app printing to a network printer on port 9100. */
class Pos {
  socket!: Socket;
  received: number[] = [];
  async connect() {
    this.socket = connect(PORT, HOST);
    this.socket.on('data', (d) => this.received.push(...d));
    await once(this.socket, 'connect');
  }
  send(bytes: Uint8Array) {
    this.socket.write(bytes);
  }
  /** Sends a real-time status request and waits for the 1-byte answer. */
  async status(n: number): Promise<number> {
    const before = this.received.length;
    this.send(DLE_EOT(n));
    await expect.poll(() => this.received.length, { timeout: 5000 }).toBeGreaterThan(before);
    return this.received[before];
  }
  close() {
    this.socket.destroy();
  }
}

const sidebar = (page: Page) => page.getByRole('complementary', { name: 'Device controls' });
const fault = (page: Page, name: string) => sidebar(page).getByRole('switch', { name });

/** Opens the panel and selects the printer on the workbench, which opens its detail panel. */
async function openPanel(page: Page) {
  await page.goto('/');
  await selectPrinter(page);
}

async function selectPrinter(page: Page) {
  await page.getByRole('button', { name: 'Configure Receipt printer' }).click();
  await expect(sidebar(page).getByText('Ready', { exact: true })).toBeVisible();
}

test('the panel shows the virtual printer ready and the 3D counter', async ({ page }) => {
  await openPanel(page);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('.stage canvas')).toBeVisible();
  await expect(sidebar(page).getByText('Epson TM-T20III · ESC/POS profile')).toBeVisible();
  await page.waitForTimeout(2500); // let the scene settle for the screenshot
  await page.screenshot({ path: 'e2e/artifacts/01-panel.png' });
});

test('a POS prints the representative ticket over TCP and the panel shows it', async ({ page }) => {
  await openPanel(page);
  const pos = new Pos();
  await pos.connect();
  await expect(sidebar(page).getByText('No POS connected')).toBeHidden();

  const cut = page.locator('.ticket-card').filter({ has: page.getByText('Cut', { exact: true }) });
  const before = await cut.count();
  pos.send(SAMPLE);
  // the encoder sends a line feed after the cut, so new paper is already in the printer too
  const card = page.locator('.ticket-card').filter({ has: page.getByText('Cut', { exact: true }) }).first();
  await expect(cut).toHaveCount(before + 1);

  await page.waitForTimeout(1200); // mid-print: paper coming out of the slot
  await page.screenshot({ path: 'e2e/artifacts/02-printing.png' });
  await page.waitForTimeout(8000); // printed, cut and dropped on the counter
  await page.screenshot({ path: 'e2e/artifacts/03-printed.png' });

  await card.click();
  const viewer = page.getByRole('dialog');
  await expect(viewer).toBeVisible();
  const image = viewer.locator('img').first();
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalHeight)).toBeGreaterThan(600);
  await expect(image).toHaveJSProperty('naturalWidth', 576);
  await page.screenshot({ path: 'e2e/artifacts/04-viewer.png' });
  await page.keyboard.press('Escape');
  await expect(viewer).toBeHidden();
  pos.close();
});

test('faults set from the panel are what the POS reads, and printing waits for recovery', async ({ page }) => {
  await openPanel(page);
  const pos = new Pos();
  await pos.connect();
  expect(await pos.status(4)).toBe(0x12);

  await fault(page, 'Paper out').click();
  await expect(sidebar(page).getByText('Offline', { exact: true })).toBeVisible();
  await expect.poll(() => pos.status(4)).toBe(0x7e);
  expect(await pos.status(1)).toBe(0x1a);

  pos.send(Buffer.from('Pendiente\n', 'latin1'));
  await expect(sidebar(page).getByText(/Buffered data/)).toBeVisible();
  await page.screenshot({ path: 'e2e/artifacts/05-paper-out.png' });

  await fault(page, 'Paper out').click();
  await expect(sidebar(page).getByText('Ready', { exact: true })).toBeVisible();
  await expect.poll(() => pos.status(4)).toBe(0x12);
  await expect(sidebar(page).getByText(/Buffered data/)).toBeHidden();

  await fault(page, 'Cover open').click();
  await expect.poll(() => pos.status(2)).toBe(0x16);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'e2e/artifacts/06-cover-open.png' });
  await fault(page, 'Cover open').click();
  await expect.poll(() => pos.status(2)).toBe(0x12);
  pos.close();
});

test('reloading the panel rebuilds the state without touching the POS session', async ({ page }) => {
  await openPanel(page);
  const pos = new Pos();
  await pos.connect();
  await fault(page, 'Paper near end').click();
  await expect.poll(() => pos.status(4)).toBe(0x1e);

  await page.reload();
  await page.getByRole('button', { name: 'Configure Receipt printer' }).click();
  await expect(fault(page, 'Paper near end')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('.ticket-card').first()).toBeVisible();
  expect(await pos.status(4)).toBe(0x1e); // same socket still answered

  await fault(page, 'Paper near end').click();
  pos.close();
});

test('the inspector shows received bytes, commands and replies', async ({ page }) => {
  await openPanel(page);
  const pos = new Pos();
  await pos.connect();
  pos.send(Buffer.from([0x1b, 0x40, 0x1d, 0x49, 67]));
  await page.getByRole('tab', { name: 'Inspector' }).click();
  await expect(page.getByText(/GS I/).last()).toBeVisible();
  await expect(page.getByText('TX').last()).toBeVisible();
  await page.screenshot({ path: 'e2e/artifacts/07-inspector.png' });
  pos.close();
});

test('disconnect closes the POS session from the panel; power off stops listening', async ({ page }) => {
  await openPanel(page);
  const pos = new Pos();
  await pos.connect();
  await expect(sidebar(page).getByRole('button', { name: 'Disconnect POS' })).toBeEnabled();
  const closed = once(pos.socket, 'close');
  await sidebar(page).getByRole('button', { name: 'Disconnect POS' }).click();
  await closed;
  await expect(sidebar(page).getByText('No POS connected')).toBeVisible();

  await sidebar(page).getByRole('switch', { name: 'Power' }).click();
  await expect(sidebar(page).getByText('Off', { exact: true })).toBeVisible();
  const refused = connect(PORT, HOST);
  const [error] = await once(refused, 'error');
  expect((error as NodeJS.ErrnoException).code).toBe('ECONNREFUSED');

  await sidebar(page).getByRole('switch', { name: 'Power' }).click();
  await expect(sidebar(page).getByText('Ready', { exact: true })).toBeVisible();
});

test('tickets can be deleted from the tray', async ({ page }) => {
  await openPanel(page);
  const cut = page.locator('.ticket-card').filter({ has: page.getByText('Cut', { exact: true }) });
  const existing = await cut.count();
  for (let i = 0; i < 2; i++) await sidebar(page).getByRole('button', { name: 'Print test receipt' }).click();
  await expect(cut).toHaveCount(existing + 2);
  const before = existing + 2;
  await page.getByRole('button', { name: /^Delete receipt/ }).first().click();
  await expect(cut).toHaveCount(before - 1);
  await page.getByRole('button', { name: 'Delete all' }).click();
  await page.getByRole('button', { name: 'Yes' }).click();
  await expect(cut).toHaveCount(0);
});

test('the in-scene tools act on the focused printer', async ({ page }) => {
  await openPanel(page);
  const tools = page.getByRole('toolbar', { name: 'Tools for Receipt printer' });
  await tools.getByRole('button', { name: 'Cover open' }).click();
  await expect(sidebar(page).getByText('Cover open', { exact: true }).first()).toBeVisible();
  await expect(fault(page, 'Cover open')).toHaveAttribute('aria-checked', 'true');
  await tools.getByRole('button', { name: 'Cover open' }).click();
  await expect(fault(page, 'Cover open')).toHaveAttribute('aria-checked', 'false');
  await page.getByRole('button', { name: 'Workbench', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Workbench', exact: true })).toBeVisible();
});

test('the self-test button prints through the same pipeline', async ({ page }) => {
  await openPanel(page);
  const before = await page.locator('.ticket-card').count();
  await sidebar(page).getByRole('button', { name: 'Print test receipt' }).click();
  await expect.poll(() => page.locator('.ticket-card').count(), { timeout: 15_000 }).toBeGreaterThan(before);
});
