import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseEther, parseGwei } from "viem";
import { noCaptcha } from "../src/captcha.ts";
import { loadConfig } from "../src/config.ts";
import { Faucet } from "../src/faucet.ts";
import { MemoryRateLimitStore } from "../src/ratelimit.ts";
import { createApp, isOwnOrigin } from "../src/server.ts";
import { redactUrls, SendError } from "../src/sender.ts";

const DEV0 = "0xC6Fe5D33615a1C52c08018c47E8Bc53646A0E101";
const DEV1 = "0x963EBDf2e1f8DB8707D05FC75bfeFFBa1B5BaC17";
const KEY = "0x88cbead91aee890d27bf06e003ade3d4e952427e88f88d31d61d3ef5e5d54305";

interface Harness {
  base: string;
  sent: string[];
  state: { balance: bigint; maxFeePerGas: bigint; rpcDown: boolean; confirmed: boolean; statusCalls: number; failWith: Error | null; codeAt: Set<string> };
  logs: string[];
  close(): Promise<void>;
}

async function harness(env: Record<string, string>, healthCacheMs = 0): Promise<Harness> {
  const state = { balance: parseEther("5000"), maxFeePerGas: 0n, rpcDown: false, confirmed: true, statusCalls: 0, failWith: null as Error | null, codeAt: new Set<string>() };
  const logs: string[] = [];
  const sent: string[] = [];
  const sender: import("../src/sender.ts").Sender = {
    address: "0x40a0cb1C63e026A81B55EE1308586E21eec1eFa9",
    async send(to) {
      if (state.failWith) {
        const e = state.failWith;
        state.failWith = null;
        throw e;
      }
      sent.push(to);
      return { txHash: "0xabc0000000000000000000000000000000000000000000000000000000000000", confirmed: state.confirmed };
    },
    async hasCode(address) {
      return state.codeAt.has(address.toLowerCase());
    },
    async status() {
      state.statusCalls++;
      if (state.rpcDown) throw new Error("ECONNREFUSED");
      return { chainId: 56670, blockNumber: 42n, faucetBalanceWei: state.balance, maxFeePerGas: state.maxFeePerGas };
    },
  };
  const config = loadConfig({ FAUCET_PRIVATE_KEY: KEY, RPC_URL: "http://127.0.0.1:8545", CHAIN_ID: "56670", NODE_ENV: "development", ALLOW_NO_CAPTCHA: "true", ...env });
  const faucet = new Faucet({
    sender,
    store: new MemoryRateLimitStore(),
    captcha: noCaptcha,
    chainId: config.chainId,
    amountWei: config.amountWei,
    amountKash: config.amountKash,
    cooldownSeconds: config.cooldownSeconds,
    bech32Prefix: config.bech32Prefix,
  });
  const handler = createApp({ config, faucet, sender, log: (msg) => void logs.push(msg), healthCacheMs });
  const server: Server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, sent, state, logs, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const JSON_CT = { "content-type": "application/json" };
const post = (base: string, body: unknown, headers: Record<string, string> = JSON_CT) =>
  fetch(`${base}/request`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });

describe("HTTP server (behind a proxy)", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness({ ALLOWED_ORIGINS: "https://good.example", TRUST_PROXY: "true", TRUSTED_PROXY_CIDRS: "127.0.0.0/8, ::1" });
  });
  afterAll(() => h.close());

  it("serves the page with a CSP and the script, and answers HEAD", async () => {
    const res = await fetch(`${h.base}/`);
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    const html = await res.text();
    expect(html).toContain("10 KASH");
    expect(html).toContain("kons1…");
    expect(html).toContain('src="/app.js"');
    expect((await fetch(`${h.base}/app.js`)).headers.get("content-type")).toContain("javascript");

    const head = await fetch(`${h.base}/`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(Buffer.byteLength(html)));
    expect(await head.text()).toBe("");
    expect((await fetch(`${h.base}/healthz`, { method: "HEAD" })).status).toBe(200);
  });

  it("reports health, pricing gas into the empty check", async () => {
    const res = await fetch(`${h.base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok", chainId: 56670, blockNumber: "42", faucetBalanceKash: "5000", lowBalance: false });

    h.state.balance = parseEther("50");
    const low = (await (await fetch(`${h.base}/healthz`)).json()) as Record<string, unknown>;
    expect(low).toMatchObject({ status: "degraded", lowBalance: true });
    expect(low["warning"]).toMatch(/below 1000 KASH/);

    // exactly one payout's amount, but gas makes it unaffordable
    h.state.balance = parseEther("10");
    h.state.maxFeePerGas = parseGwei("1");
    expect((await fetch(`${h.base}/healthz`)).status).toBe(503);
    h.state.balance = parseEther("10") + 21_000n * parseGwei("1");
    expect((await fetch(`${h.base}/healthz`)).status).toBe(200);
    h.state.balance = parseEther("5000");
    h.state.maxFeePerGas = 0n;

    h.state.rpcDown = true;
    const down = await fetch(`${h.base}/healthz`);
    expect(down.status).toBe(503);
    expect(await down.json()).toMatchObject({ status: "unhealthy", rpc: "unreachable" });
    h.state.rpcDown = false;
  });

  it("takes the client IP from the rightmost X-Forwarded-For hop and rate-limits on it", async () => {
    // client-supplied leftmost entries vary; the proxy-appended rightmost one is the same
    const first = await post(h.base, { address: DEV0 }, { ...JSON_CT, "x-forwarded-for": "198.51.100.1, 203.0.113.7" });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ txHash: expect.stringMatching(/^0x/), confirmed: true, to: DEV0, amountKash: "10", chainId: 56670 });
    expect(h.sent).toEqual([DEV0]);

    const spoofed = await post(h.base, { address: DEV1 }, { ...JSON_CT, "x-forwarded-for": "198.51.100.2, 203.0.113.7" });
    expect(spoofed.status).toBe(429);
    expect(spoofed.headers.get("retry-after")).toMatch(/^\d+$/);
    expect((await spoofed.json()).error).toMatch(/IP/);

    const sameAddr = await post(h.base, { address: DEV0.toLowerCase() }, { ...JSON_CT, "x-forwarded-for": "203.0.113.8" });
    expect(sameAddr.status).toBe(429);
    expect(h.sent).toHaveLength(1);
  });

  it("rejects a non-IP in the trusted slot, or a missing header, with 400", async () => {
    expect((await post(h.base, { address: DEV1 }, { ...JSON_CT, "x-forwarded-for": "not-an-ip-6418" })).status).toBe(400);
    expect((await post(h.base, { address: DEV1 }, { ...JSON_CT, "x-forwarded-for": "203.0.113.9, not-an-ip" })).status).toBe(400);
    expect((await post(h.base, { address: DEV1 })).status).toBe(400); // TRUST_PROXY without the header
    expect(h.sent).toHaveLength(1);
  });

  it("refuses a recipient with code with 400 contract_recipient", async () => {
    const contract = "0x0000000000000000000000000000000000009999";
    h.state.codeAt.add(contract.toLowerCase());
    const res = await post(h.base, { address: contract }, { ...JSON_CT, "x-forwarded-for": "203.0.113.99" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "contract_recipient" });
    expect(h.sent).not.toContain(contract);
  });

  it("keys IPv6 by /64 and canonicalises v4-mapped forms", async () => {
    const A = "0x0000000000000000000000000000000000001111";
    const B = "0x0000000000000000000000000000000000002222";
    const C = "0x0000000000000000000000000000000000003333";
    expect((await post(h.base, { address: A }, { ...JSON_CT, "x-forwarded-for": "2001:db8::1" })).status).toBe(200);
    expect((await post(h.base, { address: B }, { ...JSON_CT, "x-forwarded-for": "2001:DB8:0:0:0:0:0:2" })).status).toBe(429);
    expect((await post(h.base, { address: B }, { ...JSON_CT, "x-forwarded-for": "2001:db8:0:1::1" })).status).toBe(200);

    expect((await post(h.base, { address: C }, { ...JSON_CT, "x-forwarded-for": "198.51.100.50" })).status).toBe(200);
    expect((await post(h.base, { address: DEV1 }, { ...JSON_CT, "x-forwarded-for": "::FFFF:c633:6432" })).status).toBe(429);
    expect((await post(h.base, { address: DEV1 }, { ...JSON_CT, "x-forwarded-for": "[::ffff:198.51.100.50]" })).status).toBe(429);
  });

  it("requires application/json", async () => {
    const body = JSON.stringify({ address: DEV1, x: "=" });
    const xff = { "x-forwarded-for": "203.0.113.50" };
    expect((await post(h.base, body, { ...xff, "content-type": "text/plain" })).status).toBe(415);
    expect((await post(h.base, body, { ...xff })).status).toBe(415);
    expect((await post(h.base, body, { ...xff, "content-type": "application/x-www-form-urlencoded" })).status).toBe(415);
    expect((await post(h.base, body, { ...xff, "content-type": "Application/JSON; charset=utf-8" })).status).toBe(200);
  });

  it("rejects bad bodies", async () => {
    const xff = { ...JSON_CT, "x-forwarded-for": "203.0.113.60" };
    expect((await post(h.base, "{not json", xff)).status).toBe(400);
    const huge = await post(h.base, { address: "x".repeat(10_000) }, xff);
    expect(huge.status).toBe(400);
    expect(await huge.json()).toMatchObject({ error: "body too large" });
    const missing = await post(h.base, "{}", xff);
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ code: "invalid_address" });
  });

  it("only answers CORS for allowed origins, and refuses POSTs from others", async () => {
    const ok = await fetch(`${h.base}/healthz`, { headers: { origin: "https://good.example" } });
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://good.example");
    const bad = await fetch(`${h.base}/healthz`, { headers: { origin: "https://evil.example" } });
    expect(bad.headers.get("access-control-allow-origin")).toBeNull();
    expect((await fetch(`${h.base}/request`, { method: "OPTIONS", headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await fetch(`${h.base}/request`, { method: "OPTIONS", headers: { origin: "https://good.example" } })).status).toBe(204);

    const xff = { ...JSON_CT, "x-forwarded-for": "203.0.113.70" };
    expect((await post(h.base, { address: DEV1 }, { ...xff, origin: "https://evil.example" })).status).toBe(403);
    const fresh = "0x0000000000000000000000000000000000004444";
    expect((await post(h.base, { address: fresh }, { ...xff, origin: "https://good.example" })).status).toBe(200);
  });

  it("accepts its own page's Origin behind a proxy that rewrites Host (X-Forwarded-Host)", async () => {
    const fresh = "0x0000000000000000000000000000000000005555";
    const xff = { ...JSON_CT, "x-forwarded-for": "203.0.113.80" };
    // Host is the container's; the public host arrives in X-Forwarded-Host.
    const ok = await post(h.base, { address: fresh }, { ...xff, origin: "https://faucet.example", "x-forwarded-host": "faucet.example, internal" });
    expect(ok.status).toBe(200);
    // Without the forwarded host the Origin is foreign to this Host.
    const no = await post(h.base, { address: fresh }, { ...xff, origin: "https://faucet.example" });
    expect(no.status).toBe(403);
  });

  it("returns the post-broadcast guidance in the error body and keeps the cooldown", async () => {
    const h2 = await harness({});
    try {
      const hash = `0x${"cd".repeat(32)}` as const;
      h2.state.failWith = new SendError("post-broadcast", "The request took too long to respond.", hash);
      const res = await post(h2.base, { address: DEV1 });
      expect(res.status).toBe(502);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toMatchObject({ code: "send_failed", phase: "post-broadcast", txHash: hash });
      expect(body["error"]).toMatch(/may still have been paid .* cooldown stands/);
      expect((await post(h2.base, { address: DEV1 })).status).toBe(429);
    } finally {
      await h2.close();
    }
  });

  it("404s everything else", async () => {
    expect((await fetch(`${h.base}/nope`)).status).toBe(404);
    expect((await fetch(`${h.base}/request`)).status).toBe(404);
  });
});

describe("isOwnOrigin", () => {
  const req = (headers: Record<string, string>) => ({ headers }) as unknown as import("node:http").IncomingMessage;
  it("matches the request Host regardless of scheme", () => {
    expect(isOwnOrigin("https://faucet.example", req({ host: "faucet.example" }), { trustProxy: false, publicOrigin: undefined })).toBe(true);
    expect(isOwnOrigin("http://faucet.example:8080", req({ host: "Faucet.Example:8080" }), { trustProxy: false, publicOrigin: undefined })).toBe(true);
    expect(isOwnOrigin("https://evil.example", req({ host: "faucet.example" }), { trustProxy: false, publicOrigin: undefined })).toBe(false);
  });
  it("uses X-Forwarded-Host only with TRUST_PROXY", () => {
    const r = req({ host: "faucet:8080", "x-forwarded-host": "faucet.example" });
    expect(isOwnOrigin("https://faucet.example", r, { trustProxy: true, publicOrigin: undefined })).toBe(true);
    expect(isOwnOrigin("https://faucet.example", r, { trustProxy: false, publicOrigin: undefined })).toBe(false);
  });
  it("accepts PUBLIC_ORIGIN exactly", () => {
    const r = req({ host: "faucet:8080" });
    expect(isOwnOrigin("https://faucet.example", r, { trustProxy: false, publicOrigin: "https://faucet.example" })).toBe(true);
    expect(isOwnOrigin("http://faucet.example", r, { trustProxy: false, publicOrigin: "https://faucet.example" })).toBe(false);
    expect(isOwnOrigin("not a url", r, { trustProxy: false, publicOrigin: "https://faucet.example" })).toBe(false);
  });
});

describe("redactUrls", () => {
  it("strips http(s), redis and any other scheme URL", () => {
    expect(redactUrls("ECONNREFUSED http://rpc.example/v1?key=abc more")).toBe("ECONNREFUSED <url> more");
    expect(redactUrls("redis://:hunter2@redis:6379 down")).toBe("<url> down");
    expect(redactUrls('URL: "https://user:pw@h/p"')).toBe('URL: "<url>"');
    expect(redactUrls("no urls here 1:2")).toBe("no urls here 1:2");
  });
});

describe("HTTP server (TRUST_PROXY, but the peer is not a trusted proxy)", () => {
  let h: Harness;
  beforeAll(async () => {
    // loopback (the test client) is deliberately NOT in the CIDRs
    h = await harness({ TRUST_PROXY: "true", TRUSTED_PROXY_CIDRS: "10.0.0.0/8" });
  });
  afterAll(() => h.close());

  it("ignores X-Forwarded-For from an untrusted peer, keys on the peer, and logs once", async () => {
    const A = "0x0000000000000000000000000000000000007771";
    const B = "0x0000000000000000000000000000000000007772";
    expect((await post(h.base, { address: A }, { ...JSON_CT, "x-forwarded-for": "198.51.100.1" })).status).toBe(200);
    // a different spoofed XFF from the same socket peer is the same client
    expect((await post(h.base, { address: B }, { ...JSON_CT, "x-forwarded-for": "198.51.100.2" })).status).toBe(429);
    // and a garbage XFF is not a 400 either: it is simply ignored
    expect((await post(h.base, { address: B }, { ...JSON_CT, "x-forwarded-for": "not-an-ip" })).status).toBe(429);
    expect(h.sent).toEqual([A]);
    expect(h.logs.filter((m) => m.includes("not in TRUSTED_PROXY_CIDRS"))).toHaveLength(1);
  });
});

describe("HTTP server (direct, no proxy)", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness({}, 5_000);
  });
  afterAll(() => h.close());

  it("uses the socket address and ignores X-Forwarded-For", async () => {
    expect((await post(h.base, { address: DEV0 }, { ...JSON_CT, "x-forwarded-for": "198.51.100.1" })).status).toBe(200);
    expect((await post(h.base, { address: DEV1 }, { ...JSON_CT, "x-forwarded-for": "198.51.100.2" })).status).toBe(429);
  });

  it("allows a same-origin POST and refuses a foreign Origin when no CORS origins are configured", async () => {
    const host = new URL(h.base).host;
    const same = await post(h.base, { address: DEV1 }, { ...JSON_CT, origin: `http://${host}` });
    expect(same.status).toBe(429); // same-origin passes the origin check; the IP is in cooldown from the test above
    const foreign = await post(h.base, { address: DEV1 }, { ...JSON_CT, origin: "https://evil.example" });
    expect(foreign.status).toBe(403);
    expect((await fetch(`${h.base}/request`, { method: "OPTIONS", headers: { origin: "https://evil.example" } })).status).toBe(403);
  });

  it("answers 202 for a broadcast that was not confirmed in time", async () => {
    h.state.confirmed = false;
    // a fresh address; the IP claim from above is still live, so use a store-free path: new harness instead
    const h2 = await harness({});
    try {
      h2.state.confirmed = false;
      const res = await post(h2.base, { address: DEV1 });
      expect(res.status).toBe(202);
      expect(await res.json()).toMatchObject({ confirmed: false, txHash: expect.stringMatching(/^0x/) });
    } finally {
      await h2.close();
    }
  });

  it("caches /healthz for a few seconds", async () => {
    const before = h.state.statusCalls;
    await fetch(`${h.base}/healthz`);
    await fetch(`${h.base}/healthz`);
    await fetch(`${h.base}/healthz`);
    expect(h.state.statusCalls - before).toBe(1);
  });
});
