import { describe, expect, it } from "vitest";
import { claimCooldown, MemoryRateLimitStore, RateLimitedError, RedisRateLimitStore, type Clock, type RedisLikeClient } from "../src/ratelimit.js";

function fakeClock(start = 1_000_000): Clock & { advance(ms: number): void } {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

describe("MemoryRateLimitStore", () => {
  it("grants the first claim and refuses a second until the TTL passes", async () => {
    const clock = fakeClock();
    const store = new MemoryRateLimitStore(clock);
    expect(await store.claim("k", 60)).toBeNull();
    expect(await store.claim("k", 60)).toBe(60);
    clock.advance(59_000);
    expect(await store.claim("k", 60)).toBe(1);
    clock.advance(1_000);
    expect(await store.claim("k", 60)).toBeNull();
  });

  it("release drops the claim early", async () => {
    const store = new MemoryRateLimitStore(fakeClock());
    expect(await store.claim("k", 60)).toBeNull();
    await store.release("k");
    expect(await store.claim("k", 60)).toBeNull();
  });

  it("sweeps expired entries so the map does not grow forever", async () => {
    const clock = fakeClock();
    const store = new MemoryRateLimitStore(clock, 10);
    for (let i = 0; i < 10; i++) await store.claim(`k${i}`, 1);
    expect(store.size()).toBe(10);
    clock.advance(2_000);
    expect(store.size()).toBe(0);
  });

  it("keys are case-sensitive at the store level (callers normalise)", async () => {
    const store = new MemoryRateLimitStore(fakeClock());
    expect(await store.claim("A", 60)).toBeNull();
    expect(await store.claim("a", 60)).toBeNull();
  });
});

describe("RedisRateLimitStore", () => {
  function fakeRedis(): RedisLikeClient & { keys: Map<string, number> } {
    const keys = new Map<string, number>();
    return {
      keys,
      async set(key, _value, { EX, NX }) {
        expect(NX).toBe(true);
        if (keys.has(key)) return null;
        keys.set(key, EX);
        return "OK";
      },
      async ttl(key) {
        return keys.get(key) ?? -2;
      },
      async del(key) {
        return keys.delete(key) ? 1 : 0;
      },
    };
  }

  it("uses SET NX EX and reports the remaining TTL", async () => {
    const redis = fakeRedis();
    const store = new RedisRateLimitStore(redis);
    expect(await store.claim("k", 30)).toBeNull();
    expect(redis.keys.get("faucet:cooldown:k")).toBe(30);
    expect(await store.claim("k", 30)).toBe(30);
    await store.release("k");
    expect(await store.claim("k", 30)).toBeNull();
  });
});

describe("claimCooldown", () => {
  it("claims address and ip together", async () => {
    const store = new MemoryRateLimitStore(fakeClock());
    await claimCooldown(store, "0xABC", "1.2.3.4", 60);
    await expect(claimCooldown(store, "0xabc", "9.9.9.9", 60)).rejects.toMatchObject({ scope: "address", retryAfterSeconds: 60 });
    await expect(claimCooldown(store, "0xDEF", "1.2.3.4", 60)).rejects.toMatchObject({ scope: "ip", retryAfterSeconds: 60 });
  });

  it("does not consume the address claim when the ip claim fails", async () => {
    const store = new MemoryRateLimitStore(fakeClock());
    await claimCooldown(store, "0xAAA", "1.1.1.1", 60);
    await expect(claimCooldown(store, "0xBBB", "1.1.1.1", 60)).rejects.toBeInstanceOf(RateLimitedError);
    // 0xBBB must still be free for another IP
    await expect(claimCooldown(store, "0xBBB", "2.2.2.2", 60)).resolves.toBeDefined();
  });

  it("release frees both keys", async () => {
    const store = new MemoryRateLimitStore(fakeClock());
    const c = await claimCooldown(store, "0xAAA", "1.1.1.1", 60);
    await c.release();
    expect(store.size()).toBe(0);
    await expect(claimCooldown(store, "0xAAA", "1.1.1.1", 60)).resolves.toBeDefined();
  });
});
