import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  outputDir: './artifacts/results',
  // the 3D scene renders on the CPU (SwiftShader): slow on shared CI runners
  timeout: 120_000,
  expect: { timeout: 15_000 },
  workers: 1, // one virtual printer, one POS session: tests share it
  reporter: [['list']],
  use: {
    baseURL: process.env.BASE_URL ?? 'http://127.0.0.1:8100',
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] },
  },
});
