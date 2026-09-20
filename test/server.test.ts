import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseEther } from "viem";
import { noCaptcha } from "../src/captcha.js";
import { loadConfig } from "../src/config.js";
import { Faucet } from "../src/faucet.js";
import { MemoryRateLimitStore } from "../src/ratelimit.js";
import type { Sender } from "../src/sender.js";
import { createApp } from "../src/server.js";

const DEV0 = "0xC6Fe5D33615a1C52c08018c47E8Bc53646A0E101";
const DEV1 = "0x963EBDf2e1f8DB8707D05FC75bfeFFBa1B5BaC17";

describe("HTTP server", () => {
  let server: Server;
  let base: string;
  let balance = parseEther("5000");
  let rpcDown = false;
  const sent: string[] = [];

  const sender: Sender = {
    address: "0x40a0cb1C63e026A81B55EE1308586E21eec1eFa9",
    async send(to) {
      sent.push(to);
      return "0xabc0000000000000000000000000000000000000000000000000000000000000";
    },
    async status() {
      if (rpcDown) throw new Error("ECONNREFUSED");
      return { chainId: 56670, blockNumber: 42n, faucetBalanceWei: balance };
    },
  };

  beforeAll(async () => {
    const config = loadConfig({
      FAUCET_PRIVATE_KEY: "0x88cbead91aee890d27bf06e003ade3d4e952427e88f88d31d61d3ef5e5d54305",
      RPC_URL: "http://127.0.0.1:8545",
      CHAIN_ID: "56670",
      ALLOWED_ORIGINS: "https://good.example",
      TRUST_PROXY: "true",
    });
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
    const handler = createApp({ config, faucet, sender, log: () => undefined });
    server = createServer((req, res) => void handler(req, res));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("serves the page with a CSP and the script", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    const html = await res.text();
    expect(html).toContain("10 KASH");
    expect(html).toContain("kons1…");
    expect(html).toContain('src="/app.js"');
    const js = await fetch(`${base}/app.js`);
    expect(js.headers.get("content-type")).toContain("javascript");
  });

  it("reports health", async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ status: "ok", chainId: 56670, blockNumber: "42", faucetBalanceKash: "5000", lowBalance: false });

    balance = parseEther("50");
    const low = (await (await fetch(`${base}/healthz`)).json()) as Record<string, unknown>;
    expect(low).toMatchObject({ status: "degraded", lowBalance: true });
    expect(low["warning"]).toMatch(/below 1000 KASH/);

    balance = parseEther("1");
    expect((await fetch(`${base}/healthz`)).status).toBe(503);
    balance = parseEther("5000");

    rpcDown = true;
    const down = await fetch(`${base}/healthz`);
    expect(down.status).toBe(503);
    expect(await down.json()).toMatchObject({ status: "unhealthy", rpc: "unreachable" });
    rpcDown = false;
  });

  it("handles a request end to end and rate-limits the repeat", async () => {
    const res = await fetch(`${base}/request`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7, 10.0.0.1" },
      body: JSON.stringify({ address: DEV0 }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ txHash: expect.stringMatching(/^0x/), to: DEV0, amountKash: "10", chainId: 56670 });
    expect(sent).toEqual([DEV0]);

    const again = await fetch(`${base}/request`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.8" },
      body: JSON.stringify({ address: DEV0 }),
    });
    expect(again.status).toBe(429);
    expect(again.headers.get("retry-after")).toMatch(/^\d+$/);

    const sameIp = await fetch(`${base}/request`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7" },
      body: JSON.stringify({ address: DEV1 }),
    });
    expect(sameIp.status).toBe(429);
    expect(sent).toHaveLength(1);
  });

  it("rejects bad bodies", async () => {
    const notJson = await fetch(`${base}/request`, { method: "POST", body: "{not json" });
    expect(notJson.status).toBe(400);
    const huge = await fetch(`${base}/request`, { method: "POST", body: JSON.stringify({ address: "x".repeat(10_000) }) });
    expect(huge.status).toBe(400);
    expect(await huge.json()).toMatchObject({ error: "body too large" });
    const missing = await fetch(`${base}/request`, { method: "POST", body: "{}" });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ code: "invalid_address" });
  });

  it("only answers CORS for allowed origins", async () => {
    const ok = await fetch(`${base}/healthz`, { headers: { origin: "https://good.example" } });
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://good.example");
    const bad = await fetch(`${base}/healthz`, { headers: { origin: "https://evil.example" } });
    expect(bad.headers.get("access-control-allow-origin")).toBeNull();
    const preflightBad = await fetch(`${base}/request`, { method: "OPTIONS", headers: { origin: "https://evil.example" } });
    expect(preflightBad.status).toBe(403);
    const preflightOk = await fetch(`${base}/request`, { method: "OPTIONS", headers: { origin: "https://good.example" } });
    expect(preflightOk.status).toBe(204);
  });

  it("404s everything else", async () => {
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    expect((await fetch(`${base}/request`)).status).toBe(404);
  });
});
