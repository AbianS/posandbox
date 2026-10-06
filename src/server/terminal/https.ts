import { createServer, type Server } from 'node:https';
import type { Reply } from './terminal.ts';

const MAX_BODY = 1024 * 1024;

/** Network interface of the virtual terminal: Terminal API over HTTPS, `POST /nexo` on port 8443 like a real one. */
export class NexoListener {
  readonly #handle: (body: string, peer: string) => Promise<Reply>;
  #server: Server | null = null;

  constructor(handle: (body: string, peer: string) => Promise<Reply>) {
    this.#handle = handle;
  }

  get port(): number | null {
    const address = this.#server?.address();
    return address && typeof address === 'object' ? address.port : null;
  }

  listen(port: number, host: string, tls: { key: string; cert: string }): Promise<void> {
    const server = createServer({ ...tls, minVersion: 'TLSv1.2' }, async (req, res) => {
      const peer = `${req.socket.remoteAddress}:${req.socket.remotePort}`;
      // the Node and Java libraries add a trailing slash, .NET does not
      if (req.method !== 'POST' || (req.url !== '/nexo' && req.url !== '/nexo/')) {
        res.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY) return void req.socket.destroy();
        chunks.push(chunk);
      }
      const reply = await this.#handle(Buffer.concat(chunks).toString('utf8'), peer);
      if (reply === 'drop' || res.destroyed) return void req.socket.destroy();
      res.writeHead(reply.status, reply.body ? { 'content-type': 'application/json' } : {});
      res.end(reply.body);
    });
    // a payment keeps its request open until the shopper is done (Adyen: POS time-out > 120 s)
    server.requestTimeout = 0;
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        this.#server = server;
        resolve();
      });
    });
  }

  /** Power off: stop listening and cut every open request. */
  async close(): Promise<void> {
    const server = this.#server;
    this.#server = null;
    if (!server) return;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
