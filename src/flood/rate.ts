// Per-host pacing shared by every worker: a token bucket with jitter, a cap
// on actions in flight, and backoff when the site says slow down. It paces;
// it never disguises.

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface RateOptions {
  /** Actions per second per host. */
  rate: number;
  /** Actions in flight per host. */
  concurrency: number;
  /** ± fraction of the interval added at random. */
  jitter?: number;
  random?: () => number;
}

interface HostState {
  rate: number;
  nextAt: number;
  inFlight: number;
  pausedUntil: number;
  lastPenalty: number;
  waiters: (() => void)[];
}

export class HostLimiter {
  private readonly hosts = new Map<string, HostState>();
  private readonly jitter: number;
  private readonly random: () => number;
  private readonly opts: RateOptions;
  private readonly clock: Clock;

  constructor(opts: RateOptions, clock: Clock = realClock) {
    this.opts = opts;
    this.clock = clock;
    this.jitter = opts.jitter ?? 0.3;
    this.random = opts.random ?? Math.random;
  }

  private host(name: string): HostState {
    let h = this.hosts.get(name);
    if (!h) {
      h = { rate: this.opts.rate, nextAt: 0, inFlight: 0, pausedUntil: 0, lastPenalty: 0, waiters: [] };
      this.hosts.set(name, h);
    }
    return h;
  }

  /** Current rate for a host, after any backoff. */
  rateOf(name: string): number {
    return this.host(name).rate;
  }

  /** Waits for a slot, then for this host's next free moment, and holds the
   * slot until `release`. Moments are reserved in arrival order, so an item
   * taken earlier is never overtaken by one taken later (the flood's level
   * order depends on it). `cost` is how many actions the caller is about to
   * send; the next caller waits for all of them. */
  async acquire(name: string, cost = 1): Promise<void> {
    const h = this.host(name);
    while (h.inFlight >= this.opts.concurrency) {
      await new Promise<void>((resolve) => h.waiters.push(resolve));
    }
    h.inFlight += 1;
    this.recover(h);
    const now = this.clock.now();
    const slot = Math.max(now, h.nextAt, h.pausedUntil);
    const interval = 1000 / h.rate;
    const spread = interval * this.jitter * (this.random() * 2 - 1);
    h.nextAt = slot + Math.max(0, interval * cost + spread);
    if (slot > now) await this.clock.sleep(slot - now);
    // A 429 seen by another worker while this one waited still applies.
    for (let t = this.clock.now(); h.pausedUntil > t; t = this.clock.now()) {
      await this.clock.sleep(h.pausedUntil - t);
    }
  }

  release(name: string): void {
    const h = this.host(name);
    h.inFlight = Math.max(0, h.inFlight - 1);
    h.waiters.shift()?.();
  }

  /** A 429/503: halve the rate and wait `retryAfterMs` (or one interval at
   * the new rate) before anyone acts on the host again. */
  penalize(name: string, retryAfterMs?: number): void {
    const h = this.host(name);
    h.rate = Math.max(this.opts.rate / 16, h.rate / 2);
    const now = this.clock.now();
    h.pausedUntil = Math.max(h.pausedUntil, now + (retryAfterMs ?? 1000 / h.rate));
    h.lastPenalty = now;
  }

  /** Pause a host without changing its rate (a bot wall seen once). */
  pause(name: string, ms: number): void {
    const h = this.host(name);
    h.pausedUntil = Math.max(h.pausedUntil, this.clock.now() + ms);
  }

  /** After a quiet minute, the rate creeps back up, 25% at a time. */
  private recover(h: HostState): void {
    if (h.rate >= this.opts.rate || h.lastPenalty === 0) return;
    const now = this.clock.now();
    if (now - h.lastPenalty < 60_000) return;
    h.rate = Math.min(this.opts.rate, h.rate * 1.25);
    h.lastPenalty = now;
  }
}

/** `Retry-After` as milliseconds: delta-seconds or an HTTP date. */
export function parseRetryAfter(value: string | undefined, now = Date.now()): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}
