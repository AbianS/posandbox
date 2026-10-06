import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createHttpServer } from './http.ts';
import { Lab } from './lab.ts';
import type { Timing } from './terminal/terminal.ts';
import { Store } from './store.ts';

export interface LabOptions {
  dataDir: string;
  staticDir: string;
  /** Bind address for the panel and the virtual devices. Loopback unless explicitly exposed. */
  host: string;
  httpPort: number;
  /** TCP port of the default printer when there is no saved config. */
  printerPort: number;
  /** HTTPS port of the default payment terminal when there is no saved config. */
  terminalPort: number;
  /** Extra Host names accepted by the control API (e.g. a docker service name). */
  allowedHosts?: string[];
  /** Terminal durations (tests make them short). */
  timing?: Timing;
  /** Where the POS runs, seen from the lab (the scanner types into it). From Docker: host.docker.internal. */
  posHost?: string;
}

export interface RunningLab {
  lab: Lab;
  httpPort: number;
  printerPort(id: string): number | null;
  terminalPort(id: string): number | null;
  stop(): Promise<void>;
}

const SAMPLE_TICKET = new URL('../../fixtures/sample-ticket.bin', import.meta.url);

export async function startLab(options: LabOptions): Promise<RunningLab> {
  const store = new Store(options.dataDir);
  const config = store.loadConfig({
    printers: [{ id: 'front', name: 'Receipt printer', enabled: true, port: options.printerPort, paperWidth: 80 }],
    terminals: [{ id: 'counter', name: 'Payment terminal', enabled: true, port: options.terminalPort, poiid: 'V400m-324688179', sharedKey: null, notificationUrl: null }],
    scanners: [{ id: 'hand', name: 'Scanner', enabled: true, cdpHost: options.posHost ?? '127.0.0.1', cdpPort: 9222, target: '', suffix: 'Enter', keyDelay: 4 }],
  });
  const lab = new Lab(store, config, options.host, options.timing);
  await lab.start();

  const server = createHttpServer({
    lab,
    staticDir: resolve(options.staticDir),
    allowedHosts: ['localhost', '127.0.0.1', '[::1]', ...(options.allowedHosts ?? [])],
    sampleTicket: new Uint8Array(readFileSync(SAMPLE_TICKET)),
  });
  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(options.httpPort, options.host, ok);
  });

  return {
    lab,
    httpPort: (server.address() as AddressInfo).port,
    printerPort: (id) => lab.printerPort(id),
    terminalPort: (id) => lab.terminalPort(id),
    async stop() {
      server.closeAllConnections();
      await new Promise((ok) => server.close(ok));
      await lab.stop();
    },
  };
}

if (import.meta.main) {
  const env = process.env;
  const options: LabOptions = {
    dataDir: env.POSANDBOX_DATA_DIR ?? resolve('data'),
    staticDir: env.POSANDBOX_STATIC_DIR ?? resolve('dist'),
    host: env.POSANDBOX_HOST ?? '127.0.0.1',
    httpPort: Number(env.POSANDBOX_HTTP_PORT ?? 8100),
    printerPort: Number(env.POSANDBOX_PRINTER_PORT ?? 9100),
    terminalPort: Number(env.POSANDBOX_TERMINAL_PORT ?? 8443),
    posHost: env.POSANDBOX_POS_HOST,
    allowedHosts: env.POSANDBOX_ALLOWED_HOSTS?.split(',').filter(Boolean),
  };
  try {
    const running = await startLab(options);
    const snapshot = running.lab.snapshot();
    const ports = [
      ...snapshot.printers.map((p) => `${p.config.name} → tcp ${options.host}:${running.printerPort(p.config.id) ?? `(${p.status.listenError ?? 'off'})`}`),
      ...snapshot.terminals.map((t) => `${t.config.name} (${t.config.poiid}) → https ${options.host}:${running.terminalPort(t.config.id) ?? `(${t.status.listenError ?? 'off'})`}/nexo`),
    ];
    console.log(`POSandbox: panel http://${options.host}:${running.httpPort}\n  ${ports.join('\n  ')}`);
    const shutdown = async () => {
      await running.stop();
      process.exit(0);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  } catch (error) {
    const e = error as NodeJS.ErrnoException;
    console.error(e.code === 'EADDRINUSE' ? `Panel port ${options.httpPort} is in use. Set POSANDBOX_HTTP_PORT=<port>.` : e);
    process.exit(1);
  }
}
