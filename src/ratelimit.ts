// Cooldown rate limiting, keyed per recipient address and per client IP.
//
// A "claim" is an atomic set-if-absent with a TTL. Claims are taken
// *before* the send so two concurrent requests for the same address cannot
// both pass; a claim is released again if the send fails, so a transient
// RPC error does not lock a user out for the whole cooldown.
//
// `RateLimitStore` is the swap point: the in-memory store is the default
// and is enough for a single replica; `RedisRateLimitStore` wraps a
// node-redis v4+ client (`SET key value EX ttl NX`) for several replicas
// behind one address.

export interface RateLimitStore {
  /**
   * Claims `key` for `ttlSeconds` if it is not currently held.
   * Resolves to null on success, or to the number of whole seconds until
   * the existing claim expires.
   */
  claim(key: string, ttlSeconds: number): Promise<number | null>;
  /** Drops a claim early (used when the send it protected failed). */
  release(key: string): Promise<void>;
}

export interface Clock {
  now(): number; // ms
}

export const systemClock: Clock = { now: () => Date.now() };

export class MemoryRateLimitStore implements RateLimitStore {
  private readonly expiry = new Map<string, number>();
  private sweepCounter = 0;
  private readonly clock: Clock;
  private readonly sweepEvery: number;

  constructor(clock: Clock = systemClock, sweepEvery = 1000) {
    this.clock = clock;
    this.sweepEvery = sweepEvery;
  }

  async claim(key: string, ttlSeconds: number): Promise<number | null> {
    const now = this.clock.now();
    const until = this.expiry.get(key);
    if (until !== undefined && until > now) {
      return Math.ceil((until - now) / 1000);
    }
    this.expiry.set(key, now + ttlSeconds * 1000);
    if (++this.sweepCounter >= this.sweepEvery) {
      this.sweepCounter = 0;
      this.sweep(now);
    }
    return null;
  }

  async release(key: string): Promise<void> {
    this.expiry.delete(key);
  }

  /** Number of live claims; for tests and the health endpoint. */
  size(): number {
    this.sweep(this.clock.now());
    return this.expiry.size;
  }

  private sweep(now: number): void {
    for (const [k, until] of this.expiry) {
      if (until <= now) this.expiry.delete(k);
    }
  }
}

/** The subset of a node-redis v4+ client the store needs. */
export interface RedisLikeClient {
  set(key: string, value: string, options: { EX: number; NX: true }): Promise<string | null>;
  ttl(key: string): Promise<number>;
  del(key: string): Promise<number>;
}

export class RedisRateLimitStore implements RateLimitStore {
  private readonly client: RedisLikeClient;
  private readonly prefix: string;

  constructor(client: RedisLikeClient, prefix = "faucet:cooldown:") {
    this.client = client;
    this.prefix = prefix;
  }

  async claim(key: string, ttlSeconds: number): Promise<number | null> {
    const k = this.prefix + key;
    const ok = await this.client.set(k, "1", { EX: ttlSeconds, NX: true });
    if (ok === "OK") return null;
    const ttl = await this.client.ttl(k);
    // -2: vanished between SET and TTL; -1: no expiry (should not happen). Treat
    // both as "retry in a second" rather than lying about the cooldown.
    return ttl > 0 ? ttl : 1;
  }

  async release(key: string): Promise<void> {
    await this.client.del(this.prefix + key);
  }
}

export class RateLimitedError extends Error {
  override readonly name = "RateLimitedError";
  readonly scope: "address" | "ip";
  readonly retryAfterSeconds: number;

  constructor(scope: "address" | "ip", retryAfterSeconds: number) {
    super(`${scope} is in cooldown; retry in ${retryAfterSeconds}s`);
    this.scope = scope;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface Cooldown {
  /** Releases both claims; call when the protected action failed. */
  release(): Promise<void>;
}

/**
 * Takes the address and IP claims together. If the second fails the first
 * is released, so a rejected request never consumes a cooldown.
 */
export async function claimCooldown(
  store: RateLimitStore,
  address: string,
  ip: string,
  ttlSeconds: number,
): Promise<Cooldown> {
  const addrKey = `addr:${address.toLowerCase()}`;
  const ipKey = `ip:${ip}`;

  const addrWait = await store.claim(addrKey, ttlSeconds);
  if (addrWait !== null) throw new RateLimitedError("address", addrWait);

  let ipWait: number | null;
  try {
    ipWait = await store.claim(ipKey, ttlSeconds);
  } catch (e) {
    // A store error here must not leave the address claimed for the whole TTL.
    await store.release(addrKey).catch(() => undefined);
    throw e;
  }
  if (ipWait !== null) {
    await store.release(addrKey);
    throw new RateLimitedError("ip", ipWait);
  }

  return {
    release: async () => {
      await Promise.all([store.release(addrKey), store.release(ipKey)]);
    },
  };
}
