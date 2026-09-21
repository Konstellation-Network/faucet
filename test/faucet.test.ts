import { describe, expect, it } from "vitest";
import { parseEther, parseGwei } from "viem";
import { noCaptcha, type CaptchaVerifier } from "../src/captcha.ts";
import { Faucet } from "../src/faucet.ts";
import { MemoryRateLimitStore } from "../src/ratelimit.ts";
import { SendError, type Sender } from "../src/sender.ts";

const DEV0 = "0xC6Fe5D33615a1C52c08018c47E8Bc53646A0E101";
const DEV1 = "0x963EBDf2e1f8DB8707D05FC75bfeFFBa1B5BaC17";
const FAUCET = "0x40a0cb1C63e026A81B55EE1308586E21eec1eFa9"; // dev2

interface MockSender extends Sender {
  sent: { to: string; value: bigint }[];
  balance: bigint;
  maxFeePerGas: bigint;
  failNext: Error | null;
  statusFails: boolean;
  confirmed: boolean;
}

function mockSender(balance = parseEther("1000")): MockSender {
  const s: MockSender = {
    address: FAUCET,
    sent: [],
    balance,
    maxFeePerGas: 0n,
    failNext: null,
    statusFails: false,
    confirmed: true,
    async send(to, value) {
      if (s.failNext) {
        const e = s.failNext;
        s.failNext = null;
        throw e;
      }
      s.sent.push({ to, value });
      return { txHash: `0x${s.sent.length.toString(16).padStart(64, "0")}`, confirmed: s.confirmed };
    },
    async status() {
      if (s.statusFails) throw new Error("ECONNREFUSED http://secret-token@rpc.internal:8545");
      return { chainId: 56670, blockNumber: 1n, faucetBalanceWei: s.balance, maxFeePerGas: s.maxFeePerGas };
    },
  };
  return s;
}

function build(overrides: { sender?: MockSender; captcha?: CaptchaVerifier; store?: MemoryRateLimitStore } = {}) {
  const sender = overrides.sender ?? mockSender();
  const store = overrides.store ?? new MemoryRateLimitStore();
  const faucet = new Faucet({
    sender,
    store,
    captcha: overrides.captcha ?? noCaptcha,
    chainId: 56670,
    amountWei: parseEther("10"),
    amountKash: "10",
    cooldownSeconds: 3600,
    bech32Prefix: "kons",
  });
  return { faucet, sender, store };
}

describe("Faucet.request", () => {
  it("sends the configured amount to a 0x address", async () => {
    const { faucet, sender } = build();
    const r = await faucet.request({ address: DEV0, ip: "1.1.1.1" });
    expect(r).toMatchObject({ ok: true, confirmed: true, to: DEV0, toBech32: "kons1cml96vmptgw99syqrrz8az79xer2pcgpvp4mvs", amountKash: "10", chainId: 56670 });
    expect(sender.sent).toEqual([{ to: DEV0, value: parseEther("10") }]);
  });

  it("sends to a kons1 address as the same account", async () => {
    const { faucet, sender } = build();
    const r = await faucet.request({ address: "kons1cml96vmptgw99syqrrz8az79xer2pcgpvp4mvs", ip: "1.1.1.1" });
    expect(r.ok).toBe(true);
    expect(sender.sent[0]?.to).toBe(DEV0);
  });

  it("rejects malformed addresses with 400 and sends nothing", async () => {
    const { faucet, sender } = build();
    const r = await faucet.request({ address: "0x1234", ip: "1.1.1.1" });
    expect(r).toMatchObject({ ok: false, status: 400, code: "invalid_address" });
    expect(sender.sent).toHaveLength(0);
  });

  it("refuses module accounts, precompiles, the zero address and itself", async () => {
    const { faucet, sender } = build();
    for (const bad of [
      "0x0000000000000000000000000000000000000000",
      "kons17xpfvakm2amg962yls6f84z3kell8c5levxcpk", // fee_collector
      "0x0000000000000000000000000000000000000900", // compliance precompile
      "0x0000000000000000000000000000000000000001", // ecrecover
      FAUCET,
    ]) {
      const r = await faucet.request({ address: bad, ip: "1.1.1.1" });
      expect(r).toMatchObject({ ok: false, status: 400, code: "blocked_recipient" });
    }
    expect(sender.sent).toHaveLength(0);
  });

  it("enforces the per-address cooldown", async () => {
    const { faucet, sender } = build();
    expect((await faucet.request({ address: DEV0, ip: "1.1.1.1" })).ok).toBe(true);
    const r = await faucet.request({ address: DEV0.toLowerCase(), ip: "2.2.2.2" });
    expect(r).toMatchObject({ ok: false, status: 429, code: "rate_limited", retryAfterSeconds: 3600 });
    expect(sender.sent).toHaveLength(1);
  });

  it("enforces the per-ip cooldown", async () => {
    const { faucet, sender } = build();
    expect((await faucet.request({ address: DEV0, ip: "1.1.1.1" })).ok).toBe(true);
    const r = await faucet.request({ address: DEV1, ip: "1.1.1.1" });
    expect(r).toMatchObject({ ok: false, status: 429, code: "rate_limited" });
    expect((r as { error: string }).error).toMatch(/IP/);
    expect(sender.sent).toHaveLength(1);
  });

  it("refunds the cooldown on a pre-broadcast failure (the node rejected the tx)", async () => {
    const sender = mockSender();
    const { faucet } = build({ sender });
    sender.failNext = new SendError("pre-broadcast", "address is frozen");
    const r = await faucet.request({ address: DEV0, ip: "1.1.1.1" });
    expect(r).toMatchObject({ ok: false, status: 502, code: "send_failed" });
    expect((r as { error: string }).error).toBe("send failed: address is frozen");
    // second attempt goes through: the claim was released
    expect((await faucet.request({ address: DEV0, ip: "1.1.1.1" })).ok).toBe(true);
  });

  it("keeps the cooldown on a post-broadcast failure (the payout may be in the mempool)", async () => {
    const sender = mockSender();
    const { faucet, store } = build({ sender });
    sender.failNext = new SendError("post-broadcast", "The request took too long to respond.", `0x${"ab".repeat(32)}`);
    const r = await faucet.request({ address: DEV0, ip: "1.1.1.1" });
    expect(r).toMatchObject({ ok: false, status: 502, code: "send_failed" });
    expect(store.size()).toBe(2);
    // the retry that drained the first version is now rate-limited
    expect(await faucet.request({ address: DEV0, ip: "1.1.1.1" })).toMatchObject({ status: 429 });
    expect(await faucet.request({ address: DEV1, ip: "1.1.1.1" })).toMatchObject({ status: 429 });
    expect(sender.sent).toHaveLength(0);
  });

  it("keeps the cooldown on an unclassified error", async () => {
    const sender = mockSender();
    const { faucet, store } = build({ sender });
    sender.failNext = new Error("socket hang up");
    await faucet.request({ address: DEV0, ip: "1.1.1.1" });
    expect(store.size()).toBe(2);
  });

  it("reports an unconfirmed broadcast as success with confirmed:false", async () => {
    const sender = mockSender();
    sender.confirmed = false;
    const { faucet } = build({ sender });
    expect(await faucet.request({ address: DEV0, ip: "1.1.1.1" })).toMatchObject({ ok: true, confirmed: false });
  });

  it("refuses when the balance cannot cover amount + gas, without spending a cooldown", async () => {
    const sender = mockSender(parseEther("9.99"));
    const { faucet, store } = build({ sender });
    expect(await faucet.request({ address: DEV0, ip: "1.1.1.1" })).toMatchObject({ ok: false, status: 503, code: "faucet_empty" });
    expect(store.size()).toBe(0);

    // balance in [amount, amount + fee): still empty once gas is priced in
    sender.balance = parseEther("10") + 20_000n * parseGwei("50");
    sender.maxFeePerGas = parseGwei("50");
    expect(await faucet.request({ address: DEV0, ip: "1.1.1.1" })).toMatchObject({ status: 503, code: "faucet_empty" });
    expect(store.size()).toBe(0);

    sender.balance = parseEther("10") + 21_000n * parseGwei("50");
    expect((await faucet.request({ address: DEV0, ip: "1.1.1.1" })).ok).toBe(true);
  });

  it("refunds the cooldown and redacts the URL when the status call fails", async () => {
    const sender = mockSender();
    sender.statusFails = true;
    const { faucet, store } = build({ sender });
    const r = await faucet.request({ address: DEV0, ip: "1.1.1.1" });
    expect(r).toMatchObject({ ok: false, status: 502 });
    expect(JSON.stringify(r)).not.toContain("secret-token");
    expect(store.size()).toBe(0);
  });

  it("hands the captcha the full client address, not the rate-limit key", async () => {
    const seen: string[] = [];
    const captcha: CaptchaVerifier = {
      async verify(_token, ip) {
        seen.push(ip);
        return true;
      },
    };
    const { faucet } = build({ captcha });
    await faucet.request({ address: DEV0, ip: "2001:db8:0:0::/64", clientAddress: "2001:db8:0:0:0:0:0:1" });
    expect(seen).toEqual(["2001:db8:0:0:0:0:0:1"]);
  });

  it("requires a valid captcha when a verifier is configured", async () => {
    const seen: (string | undefined)[] = [];
    const captcha: CaptchaVerifier = {
      async verify(token) {
        seen.push(token);
        return token === "good";
      },
    };
    const { faucet, sender, store } = build({ captcha });
    expect(await faucet.request({ address: DEV0, ip: "1.1.1.1" })).toMatchObject({ ok: false, status: 403, code: "captcha_failed" });
    expect(await faucet.request({ address: DEV0, ip: "1.1.1.1", captchaToken: "bad" })).toMatchObject({ status: 403 });
    expect(store.size()).toBe(0); // a failed captcha never claims a cooldown
    expect((await faucet.request({ address: DEV0, ip: "1.1.1.1", captchaToken: "good" })).ok).toBe(true);
    expect(seen).toEqual([undefined, "bad", "good"]);
    expect(sender.sent).toHaveLength(1);
  });

  it("serialises concurrent requests for the same address to one send", async () => {
    const { faucet, sender } = build();
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => faucet.request({ address: DEV0, ip: `10.0.0.${i}` })),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(sender.sent).toHaveLength(1);
  });
});
