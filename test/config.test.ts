import { describe, expect, it } from "vitest";
import { parseEther } from "viem";
import { ConfigError, describeConfig, loadConfig } from "../src/config.ts";

const KEY = "0x88cbead91aee890d27bf06e003ade3d4e952427e88f88d31d61d3ef5e5d54305"; // dev0, public
const base = { FAUCET_PRIVATE_KEY: KEY, RPC_URL: "http://127.0.0.1:8545", NODE_ENV: "development" };
const CIDRS = { TRUSTED_PROXY_CIDRS: "10.0.0.0/8" };

describe("loadConfig", () => {
  it("applies the documented defaults", () => {
    const c = loadConfig(base);
    expect(c.chainId).toBe(56672);
    expect(c.amountKash).toBe("10");
    expect(c.amountWei).toBe(parseEther("10"));
    expect(c.cooldownSeconds).toBe(86_400);
    expect(c.lowBalanceWei).toBe(parseEther("1000"));
    expect(c.port).toBe(8080);
    expect(c.allowedOrigins).toEqual([]);
    expect(c.trustProxy).toBe(false);
    expect(c.rateLimitStore).toBe("memory");
    expect(c.captcha.provider).toBe("off");
    expect(c.networkName).toBe("devnet-1");
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

  it("serves devnet-1 (primary) and testnet-1, one network per deployment", () => {
    const dev = loadConfig({ ...base, CHAIN_ID: "56672" });
    expect(dev.chainId).toBe(56672);
    expect(dev.networkName).toBe("devnet-1");
    const test = loadConfig({ ...base, CHAIN_ID: "56671" });
    expect(test.chainId).toBe(56671);
    expect(test.networkName).toBe("testnet-1");
    expect(loadConfig({ ...base, CHAIN_ID: "56670" }).networkName).toBe("local");
    expect(loadConfig({ ...base, CHAIN_ID: "56671", NETWORK_NAME: "rehearsal" }).networkName).toBe("rehearsal");
  });

  it("caps the per-request amount", () => {
    expect(() => loadConfig({ ...base, AMOUNT_KASH: "1001" })).toThrow(/hard cap/);
    expect(() => loadConfig({ ...base, AMOUNT_KASH: "10000000000000000000" })).toThrow(/hard cap/);
    expect(() => loadConfig({ ...base, AMOUNT_KASH: "0" })).toThrow(/positive/);
    expect(() => loadConfig({ ...base, AMOUNT_KASH: "1e3" })).toThrow(/decimal/);
    expect(loadConfig({ ...base, AMOUNT_KASH: "0.5" }).amountWei).toBe(parseEther("0.5"));
  });

  it("refuses wildcard CORS outside development", () => {
    expect(() => loadConfig({ ...base, ALLOWED_ORIGINS: "*", NODE_ENV: "" })).toThrow(/NODE_ENV=development/);
    expect(() => loadConfig({ ...base, ALLOWED_ORIGINS: "*", NODE_ENV: "production" })).toThrow(ConfigError);
    expect(loadConfig({ ...base, ALLOWED_ORIGINS: "*", NODE_ENV: "development", ALLOW_NO_CAPTCHA: "true" }).allowedOrigins).toEqual(["*"]);
    expect(loadConfig({ ...base, ALLOW_NO_CAPTCHA: "true", ALLOWED_ORIGINS: "https://faucet.example, https://docs.example:8443" }).allowedOrigins).toEqual([
      "https://faucet.example",
      "https://docs.example:8443",
    ]);
    expect(() => loadConfig({ ...base, ALLOW_NO_CAPTCHA: "true", ALLOWED_ORIGINS: "https://a.example/path" })).toThrow(/origin/);
  });

  it("validates the captcha and redis settings", () => {
    expect(() => loadConfig({ ...base, CAPTCHA_PROVIDER: "hcaptcha" })).toThrow(/CAPTCHA_SECRET/);
    expect(loadConfig({ ...base, CAPTCHA_PROVIDER: "turnstile", CAPTCHA_SECRET: "s", CAPTCHA_SITE_KEY: "k" }).captcha.provider).toBe("turnstile");
    expect(() => loadConfig({ ...base, CAPTCHA_PROVIDER: "recaptcha" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, RATE_LIMIT_STORE: "redis" })).toThrow(/REDIS_URL/);
    expect(loadConfig({ ...base, RATE_LIMIT_STORE: "redis", REDIS_URL: "redis://r:6379" }).redisUrl).toBe("redis://r:6379");
  });

  it("lower-cases and validates the bech32 prefix", () => {
    expect(loadConfig({ ...base, BECH32_PREFIX: "Kons" }).bech32Prefix).toBe("kons");
    expect(loadConfig({ ...base, BECH32_PREFIX: "COSMOS" }).bech32Prefix).toBe("cosmos");
    expect(() => loadConfig({ ...base, BECH32_PREFIX: "ko ns" })).toThrow(/BECH32_PREFIX/);
    expect(() => loadConfig({ ...base, BECH32_PREFIX: "kons1" })).not.toThrow(); // digits are legal in an hrp
    expect(() => loadConfig({ ...base, BECH32_PREFIX: "k".repeat(21) })).toThrow(/BECH32_PREFIX/);
  });

  it("reads proxy hops and the confirmation timeout", () => {
    expect(loadConfig(base).trustedProxyHops).toBe(1);
    expect(loadConfig(base).confirmTimeoutMs).toBe(20_000);
    expect(loadConfig({ ...base, TRUSTED_PROXY_HOPS: "2", CONFIRM_TIMEOUT_SECONDS: "5" })).toMatchObject({ trustedProxyHops: 2, confirmTimeoutMs: 5_000 });
    expect(loadConfig({ ...base, TRUST_PROXY: "true", ...CIDRS, ALLOW_NO_CAPTCHA: "true" }).trustedProxyCidrs.map((c) => c.text)).toEqual(["10.0.0.0/8"]);
    expect(() => loadConfig({ ...base, TRUSTED_PROXY_HOPS: "0" })).toThrow(/between/);
  });

  it("reads the lookup window and PUBLIC_ORIGIN", () => {
    expect(loadConfig(base).lookupWindowMs).toBe(3_000);
    expect(loadConfig(base).publicOrigin).toBeUndefined();
    const ok = { ...base, ALLOW_NO_CAPTCHA: "true" };
    expect(loadConfig({ ...ok, LOOKUP_WINDOW_SECONDS: "5", PUBLIC_ORIGIN: "https://Faucet.Example/" })).toMatchObject({ lookupWindowMs: 5_000, publicOrigin: "https://faucet.example" });
    expect(() => loadConfig({ ...ok, PUBLIC_ORIGIN: "faucet.example" })).toThrow(/PUBLIC_ORIGIN/);
    expect(() => loadConfig({ ...ok, PUBLIC_ORIGIN: "https://faucet.example/path" })).toThrow(/PUBLIC_ORIGIN/);
  });

  it("never puts the RPC URL in the log description", () => {
    const c = loadConfig({ ...base, RPC_URL: "https://user:token@rpc.example/v1?key=abc" });
    const d = JSON.stringify(describeConfig(c));
    expect(d).not.toContain("token");
    expect(d).not.toContain("key=abc");
    expect(d).toContain("rpc.example");
  });

  it("requires TRUSTED_PROXY_CIDRS with TRUST_PROXY and validates them", () => {
    expect(() => loadConfig({ ...base, TRUST_PROXY: "true", ALLOW_NO_CAPTCHA: "true" })).toThrow(/TRUSTED_PROXY_CIDRS/);
    expect(() => loadConfig({ ...base, TRUST_PROXY: "true", ALLOW_NO_CAPTCHA: "true", TRUSTED_PROXY_CIDRS: "10.0.0.0/33" })).toThrow(/not an IP or CIDR/);
    expect(() => loadConfig({ ...base, TRUST_PROXY: "true", ALLOW_NO_CAPTCHA: "true", TRUSTED_PROXY_CIDRS: "proxy" })).toThrow(/not an IP or CIDR/);
    const c = loadConfig({ ...base, TRUST_PROXY: "true", ALLOW_NO_CAPTCHA: "true", TRUSTED_PROXY_CIDRS: " 172.16.0.0/12, 2001:db8::/32 ,192.0.2.7" });
    expect(c.trustedProxyCidrs.map((x) => x.text)).toEqual(["172.16.0.0/12", "2001:db8:0:0:0:0:0:0/32", "192.0.2.7/32"]);
    // CIDRs without TRUST_PROXY are accepted and unused
    expect(loadConfig({ ...base, ...CIDRS }).trustProxy).toBe(false);
  });

  it("refuses CAPTCHA_PROVIDER=off on a public-looking deployment unless ALLOW_NO_CAPTCHA", () => {
    const captcha = { CAPTCHA_PROVIDER: "turnstile", CAPTCHA_SECRET: "s", CAPTCHA_SITE_KEY: "k" };
    const noEnv = { FAUCET_PRIVATE_KEY: KEY, RPC_URL: base.RPC_URL };
    for (const pub of [
      { NODE_ENV: "production" },
      {}, // unset counts as production
      { NODE_ENV: "development", TRUST_PROXY: "true", ...CIDRS },
      { NODE_ENV: "development", ALLOWED_ORIGINS: "https://docs.example" },
      { NODE_ENV: "development", PUBLIC_ORIGIN: "https://faucet.example" },
    ]) {
      expect(() => loadConfig({ ...noEnv, ...pub })).toThrow(/CAPTCHA_PROVIDER=off/);
      expect(loadConfig({ ...noEnv, ...pub, ALLOW_NO_CAPTCHA: "true" })).toMatchObject({ allowNoCaptcha: true });
      expect(loadConfig({ ...noEnv, ...pub, ...captcha }).captcha.provider).toBe("turnstile");
    }
    expect(loadConfig(base).allowNoCaptcha).toBe(false); // plain development needs nothing
  });

  it("bounds integers", () => {
    expect(() => loadConfig({ ...base, COOLDOWN_SECONDS: "0" })).toThrow(/between/);
    expect(() => loadConfig({ ...base, PORT: "70000" })).toThrow(/between/);
    expect(() => loadConfig({ ...base, PORT: "eighty" })).toThrow(/integer/);
  });
});
