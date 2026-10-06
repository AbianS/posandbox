/**
 * The control API can switch faults on a device the POS is using, so a random web page must not reach it.
 * Host must be an allowed name (blocks DNS rebinding); a browser Origin must be the same host and port.
 */
export function isAllowedRequest(headers: { host?: string; origin?: string }, allowedHosts: string[]): boolean {
  const { host, origin } = headers;
  if (!host || !allowedHosts.includes(hostname(host))) return false;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

const hostname = (host: string) => (host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]);

/** Fixed-window request counter per client address. */
export class RateLimiter {
  readonly limit: number;
  readonly windowMs: number;
  readonly now: () => number;
  #windows = new Map<string, { start: number; count: number }>();

  constructor(limit: number, windowMs: number, now = Date.now) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
  }

  take(client: string): boolean {
    const now = this.now();
    let w = this.#windows.get(client);
    if (!w || now - w.start >= this.windowMs) {
      if (this.#windows.size > 1000) this.#windows.clear();
      w = { start: now, count: 0 };
      this.#windows.set(client, w);
    }
    return ++w.count <= this.limit;
  }
}
