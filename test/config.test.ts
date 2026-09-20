import { describe, expect, it } from "vitest";
import { parseEther } from "viem";
import { ConfigError, loadConfig } from "../src/config.js";

const KEY = "0x88cbead91aee890d27bf06e003ade3d4e952427e88f88d31d61d3ef5e5d54305"; // dev0, public
const base = { FAUCET_PRIVATE_KEY: KEY, RPC_URL: "http://127.0.0.1:8545" };

describe("loadConfig", () => {
  it("applies the documented defaults", () => {
    const c = loadConfig(base);
    expect(c.chainId).toBe(56671);
    expect(c.amountKash).toBe("10");
    expect(c.amountWei).toBe(parseEther("10"));
    expect(c.cooldownSeconds).toBe(86_400);
    expect(c.lowBalanceWei).toBe(parseEther("1000"));
    expect(c.port).toBe(8080);
    expect(c.allowedOrigins).toEqual([]);
    expect(c.trustProxy).toBe(false);
    expect(c.rateLimitStore).toBe("memory");
    expect(c.captcha.provider).toBe("off");
    expect(c.networkName).toBe("testnet-1");
    expect(c.bech32Prefix).toBe("kons");
  });

  it("accepts a key without the 0x prefix", () => {
    expect(loadConfig({ ...base, FAUCET_PRIVATE_KEY: KEY.slice(2) }).privateKey).toBe(KEY);
  });

  it("requires the key and the RPC URL", () => {
    expect(() => loadConfig({ RPC_URL: base.RPC_URL })).toThrow(/FAUCET_PRIVATE_KEY/);
    expect(() => loadConfig({ FAUCET_PRIVATE_KEY: KEY })).toThrow(/RPC_URL/);
    expect(() => loadConfig({ ...base, FAUCET_PRIVATE_KEY: "0x1234" })).toThrow(ConfigError);
  });

  it("refuses the mainnet chain id", () => {
    expect(() => loadConfig({ ...base, CHAIN_ID: "5667" })).toThrow(/testnet-only/);
    expect(loadConfig({ ...base, CHAIN_ID: "56670" }).chainId).toBe(56670);
  });

  it("caps the per-request amount", () => {
    expect(() => loadConfig({ ...base, AMOUNT_KASH: "1001" })).toThrow(/hard cap/);
    expect(() => loadConfig({ ...base, AMOUNT_KASH: "10000000000000000000" })).toThrow(/hard cap/);
    expect(() => loadConfig({ ...base, AMOUNT_KASH: "0" })).toThrow(/positive/);
    expect(() => loadConfig({ ...base, AMOUNT_KASH: "1e3" })).toThrow(/decimal/);
    expect(loadConfig({ ...base, AMOUNT_KASH: "0.5" }).amountWei).toBe(parseEther("0.5"));
  });

  it("refuses wildcard CORS outside development", () => {
    expect(() => loadConfig({ ...base, ALLOWED_ORIGINS: "*" })).toThrow(/NODE_ENV=development/);
    expect(() => loadConfig({ ...base, ALLOWED_ORIGINS: "*", NODE_ENV: "production" })).toThrow(ConfigError);
    expect(loadConfig({ ...base, ALLOWED_ORIGINS: "*", NODE_ENV: "development" }).allowedOrigins).toEqual(["*"]);
    expect(loadConfig({ ...base, ALLOWED_ORIGINS: "https://faucet.example, https://docs.example:8443" }).allowedOrigins).toEqual([
      "https://faucet.example",
      "https://docs.example:8443",
    ]);
    expect(() => loadConfig({ ...base, ALLOWED_ORIGINS: "https://a.example/path" })).toThrow(/origin/);
  });

  it("validates the captcha and redis settings", () => {
    expect(() => loadConfig({ ...base, CAPTCHA_PROVIDER: "hcaptcha" })).toThrow(/CAPTCHA_SECRET/);
    expect(loadConfig({ ...base, CAPTCHA_PROVIDER: "turnstile", CAPTCHA_SECRET: "s", CAPTCHA_SITE_KEY: "k" }).captcha.provider).toBe("turnstile");
    expect(() => loadConfig({ ...base, CAPTCHA_PROVIDER: "recaptcha" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, RATE_LIMIT_STORE: "redis" })).toThrow(/REDIS_URL/);
    expect(loadConfig({ ...base, RATE_LIMIT_STORE: "redis", REDIS_URL: "redis://r:6379" }).redisUrl).toBe("redis://r:6379");
  });

  it("bounds integers", () => {
    expect(() => loadConfig({ ...base, COOLDOWN_SECONDS: "0" })).toThrow(/between/);
    expect(() => loadConfig({ ...base, PORT: "70000" })).toThrow(/between/);
    expect(() => loadConfig({ ...base, PORT: "eighty" })).toThrow(/integer/);
  });
});
