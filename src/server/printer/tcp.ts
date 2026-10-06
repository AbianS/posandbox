import { createServer, type Server, type Socket } from 'node:net';

/** What the TCP side needs from a device. One POS session at a time. */
export interface TcpDevice {
  /** Returns false to refuse the session (another client is active). */
  open(address: string, transmit: (bytes: Uint8Array) => void): boolean;
  close(reason: string): void;
  rejected(address: string): void;
  receive(bytes: Uint8Array): void;
  /** False while the receive buffer is full: the socket stops reading (TCP backpressure). */
  readonly accepting: boolean;
}

/** Network interface of the virtual printer: a raw TCP port (like port 9100 on a real one). */
export class TcpListener {
  readonly device: TcpDevice;
  #server: Server | null = null;
  #socket: Socket | null = null;

  constructor(device: TcpDevice) {
    this.device = device;
  }

  get port(): number | null {
    const address = this.#server?.address();
    return address && typeof address === 'object' ? address.port : null;
  }

  listen(port: number, host: string): Promise<void> {
    const server = createServer({ noDelay: true }, (socket) => this.#accept(socket));
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        this.#server = server;
        resolve();
      });
    });
  }

  /** Stop listening and drop the active client (printer powered off). */
  async close(reason: string): Promise<void> {
    this.disconnect(reason);
    const server = this.#server;
    this.#server = null;
    if (server) await new Promise((resolve) => server.close(resolve));
  }

  /** Drop the active client, keep listening. */
  disconnect(reason: string): void {
    const socket = this.#socket;
    if (!socket) return;
    this.#end(socket, reason);
    socket.destroy();
  }

  /** Call when the device can accept input again. */
  resume(): void {
    if (this.device.accepting) this.#socket?.resume();
  }

  #accept(socket: Socket): void {
    const address = `${socket.remoteAddress}:${socket.remotePort}`;
    const transmit = (bytes: Uint8Array) => {
      if (!socket.destroyed) socket.write(bytes);
    };
    if (this.#socket || !this.device.open(address, transmit)) {
      this.device.rejected(address);
      socket.destroy();
      return;
    }
    this.#socket = socket;
    socket.on('data', (chunk) => {
      this.device.receive(chunk);
      if (!this.device.accepting) socket.pause();
    });
    socket.on('error', () => {}); // reported by 'close'
    socket.on('close', (hadError) => this.#end(socket, hadError ? 'connection error' : 'client closed'));
  }

  #end(socket: Socket, reason: string): void {
    if (this.#socket !== socket) return;
    this.#socket = null;
    this.device.close(reason);
  }
}
