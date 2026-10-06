import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect, type Socket } from 'node:net';
import { once } from 'node:events';
import { TcpListener, type TcpDevice } from './tcp.ts';

class FakeDevice implements TcpDevice {
  received: number[] = [];
  sessions: string[] = [];
  transmit: ((bytes: Uint8Array) => void) | null = null;
  accepting = true;
  onAccepting: (() => void) | null = null;
  open(address: string, transmit: (b: Uint8Array) => void) {
    if (this.transmit) return false;
    this.sessions.push(`open ${address}`);
    this.transmit = transmit;
    return true;
  }
  close(reason: string) {
    this.sessions.push(`close ${reason}`);
    this.transmit = null;
  }
  rejected(address: string) {
    this.sessions.push(`reject ${address}`);
  }
  receive(bytes: Uint8Array) {
    this.received.push(...bytes);
    if (bytes.includes(0xee)) this.transmit?.(Uint8Array.of(0x12));
  }
}

const tick = () => new Promise((r) => setTimeout(r, 20));
const client = async (port: number) => {
  const s = connect(port, '127.0.0.1');
  await once(s, 'connect');
  return s;
};

async function withListener(fn: (l: TcpListener, d: FakeDevice, port: number) => Promise<void>) {
  const device = new FakeDevice();
  const listener = new TcpListener(device);
  await listener.listen(0, '127.0.0.1');
  try {
    await fn(listener, device, listener.port!);
  } finally {
    await listener.close('test end');
  }
}

test('delivers bytes to the device and the device replies on the same connection', () =>
  withListener(async (_l, device, port) => {
    const s = await client(port);
    s.write(Uint8Array.of(0x1b, 0x40, 0xee));
    const [reply] = await once(s, 'data');
    assert.deepEqual([...reply], [0x12]);
    assert.deepEqual(device.received, [0x1b, 0x40, 0xee]);
    s.destroy();
  }));

test('rejects a second simultaneous client observably and keeps the first session', () =>
  withListener(async (_l, device, port) => {
    const first = await client(port);
    const second = await client(port);
    await once(second, 'close');
    assert.match(device.sessions[1], /^reject /);
    first.write(Uint8Array.of(0xee));
    const [reply] = await once(first, 'data');
    assert.deepEqual([...reply], [0x12]);
    first.destroy();
  }));

test('reports when the POS closes the connection, and accepts a new one afterwards', () =>
  withListener(async (_l, device, port) => {
    const s = await client(port);
    s.end();
    await tick();
    assert.equal(device.sessions.at(-1), 'close client closed');
    const again = await client(port);
    await tick();
    assert.match(device.sessions.at(-1)!, /^open /);
    again.destroy();
  }));

test('disconnect() drops the current client but keeps listening', () =>
  withListener(async (listener, device, port) => {
    const s = await client(port);
    await tick();
    const closed = once(s, 'close');
    listener.disconnect('panel');
    await closed;
    assert.equal(device.sessions.at(-1), 'close panel');
    (await client(port)).destroy();
  }));

test('close() stops listening and closes the active client', () =>
  withListener(async (listener, device, port) => {
    const s: Socket = await client(port);
    await tick();
    const closed = once(s, 'close');
    await listener.close('power off');
    await closed;
    assert.equal(device.sessions.at(-1), 'close power off');
    const refused = connect(port, '127.0.0.1');
    const [err] = await once(refused, 'error');
    assert.equal((err as NodeJS.ErrnoException).code, 'ECONNREFUSED');
  }));

test('pauses reading while the device cannot accept input and resumes when it can', () =>
  withListener(async (listener, device, port) => {
    const s = await client(port);
    device.accepting = false;
    s.write(Uint8Array.of(1));
    await tick();
    s.write(Uint8Array.of(2));
    await tick();
    assert.deepEqual(device.received, [1]);
    device.accepting = true;
    listener.resume();
    await tick();
    assert.deepEqual(device.received, [1, 2]);
    s.destroy();
  }));

test('listen() reports a busy port instead of crashing', async () => {
  await withListener(async (_l, _d, port) => {
    const other = new TcpListener(new FakeDevice());
    await assert.rejects(other.listen(port, '127.0.0.1'), { code: 'EADDRINUSE' });
  });
});
