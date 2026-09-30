// Configuration, all from the environment. Nothing here is read from a
// file the repo could contain: the faucet key in particular arrives only
// through FAUCET_PRIVATE_KEY (a Docker/Coolify secret in deployment).

import { parseEther } from "viem";
import { parseCidr, type Cidr } from "./ip.ts";

export const MAINNET_CHAIN_ID = 5667; // ENGINEERING.md §1 — the faucet must never run here
export const DEVNET_CHAIN_ID = 56672; // devnet-1 — the primary faucet (dapp developers)
export const TESTNET_CHAIN_ID = 56671; // testnet-1 — validator/ops rehearsal network
export const LOCAL_CHAIN_ID = 56670;

/**
 * Display names of the networks a faucet may run on (ENGINEERING.md §1, §18).
 * One deployment serves one network, selected by CHAIN_ID; devnet-1 and
 * testnet-1 each get their own deployment, key and genesis allocation.
 */
export const KNOWN_NETWORKS: Readonly<Record<number, string>> = Object.freeze({
  [DEVNET_CHAIN_ID]: "devnet-1",
  [TESTNET_CHAIN_ID]: "testnet-1",
  [LOCAL_CHAIN_ID]: "local",
});

/**
 * Ceiling on AMOUNT_KASH. Not a policy number — a guard against a fat-fingered
 * env var (e.g. an esp value pasted where KASH was meant) draining the
 * liquidity bucket in one request.
 */
export const HARD_MAX_AMOUNT_KASH = 1000;

export type CaptchaProvider = "off" | "hcaptcha" | "turnstile";

export interface FaucetConfig {
  privateKey: `0x${string}`;
  rpcUrl: string;
  chainId: number;
  bech32Prefix: string;
  amountKash: string;
  amountWei: bigint;
  cooldownSeconds: number;
  lowBalanceWei: bigint;
  port: number;
  host: string;
  allowedOrigins: string[];
  trustProxy: boolean;
  /** With trustProxy: how many proxies append to X-Forwarded-For; the client is that many hops from the right. */
  trustedProxyHops: number;
  /** With trustProxy: forwarded headers are honoured only when the socket peer is inside one of these. */
  trustedProxyCidrs: Cidr[];
  /** How long a request waits for the receipt before answering 202 "broadcast". */
  confirmTimeoutMs: number;
  /** After a lost broadcast response: how long the sender looks for the tx by hash. */
  lookupWindowMs: number;
  /** The origin the page is served from, when the request Host does not say (behind a Host-rewriting proxy). */
  publicOrigin: string | undefined;
  rateLimitStore: "memory" | "redis";
  redisUrl: string | undefined;
  captcha: {
    provider: CaptchaProvider;
    secret: string | undefined;
    siteKey: string | undefined;
  };
  /** CAPTCHA_PROVIDER=off was explicitly allowed on a public-looking deployment. */
  allowNoCaptcha: boolean;
  /** Public-facing text for the page. */
  networkName: string;
  explorerTxUrl: string | undefined;
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

type Env = Record<string, string | undefined>;

function str(env: Env, key: string, fallback?: string): string {
  const v = env[key]?.trim();
  if (v !== undefined && v !== "") return v;
  if (fallback !== undefined) return fallback;
  throw new ConfigError(`${key} is required`);
}

function int(env: Env, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key]?.trim();
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) throw new ConfigError(`${key} must be a non-negative integer, got "${raw}"`);
  const n = Number(raw);
  if (n < min || n > max) throw new ConfigError(`${key} must be between ${min} and ${max}, got ${n}`);
  return n;
}

function bool(env: Env, key: string, fallback: boolean): boolean {
  const raw = env[key]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  if (raw === "true" || raw === "1" || raw === "yes") return true;
  if (raw === "false" || raw === "0" || raw === "no") return false;
  throw new ConfigError(`${key} must be true or false, got "${raw}"`);
}

/** Decimal KASH → esp (wei), refusing anything that is not a plain positive decimal. */
export function parseKash(key: string, raw: string): bigint {
  if (!/^\d+(\.\d{1,18})?$/.test(raw)) {
    throw new ConfigError(`${key} must be a decimal KASH amount (up to 18 decimals), got "${raw}"`);
  }
  const wei = parseEther(raw);
  if (wei <= 0n) throw new ConfigError(`${key} must be positive`);
  return wei;
}

export function loadConfig(env: Env = process.env): FaucetConfig {
  const privateKeyRaw = str(env, "FAUCET_PRIVATE_KEY");
  const privateKey = (privateKeyRaw.startsWith("0x") ? privateKeyRaw : `0x${privateKeyRaw}`) as `0x${string}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new ConfigError("FAUCET_PRIVATE_KEY must be a 32-byte hex private key");
  }

  const rpcUrl = str(env, "RPC_URL");
  if (!/^https?:\/\//.test(rpcUrl)) throw new ConfigError("RPC_URL must be an http(s) URL");

  const chainId = int(env, "CHAIN_ID", DEVNET_CHAIN_ID, 1, 2 ** 32);
  if (chainId === MAINNET_CHAIN_ID) {
    // ENGINEERING.md §18: the faucet does not exist on konstellation-1.
    throw new ConfigError(`CHAIN_ID ${MAINNET_CHAIN_ID} is konstellation-1 (mainnet); the faucet is testnet-only (devnet-1, testnet-1)`);
  }

  const amountKash = str(env, "AMOUNT_KASH", "10");
  const amountWei = parseKash("AMOUNT_KASH", amountKash);
  if (amountWei > parseEther(String(HARD_MAX_AMOUNT_KASH))) {
    throw new ConfigError(`AMOUNT_KASH ${amountKash} exceeds the hard cap of ${HARD_MAX_AMOUNT_KASH} KASH per request`);
  }

  const cooldownSeconds = int(env, "COOLDOWN_SECONDS", 86_400, 1, 30 * 86_400);

  // Default warning threshold: 100 requests' worth.
  const lowBalanceRaw = env["LOW_BALANCE_KASH"]?.trim();
  const lowBalanceWei =
    lowBalanceRaw !== undefined && lowBalanceRaw !== ""
      ? parseKash("LOW_BALANCE_KASH", lowBalanceRaw)
      : amountWei * 100n;

  const port = int(env, "PORT", 8080, 1, 65_535);
  const host = str(env, "HOST", "0.0.0.0");

  const allowedOrigins = (env["ALLOWED_ORIGINS"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const nodeEnv = env["NODE_ENV"] ?? "production";
  for (const origin of allowedOrigins) {
    if (origin === "*") {
      if (nodeEnv !== "development") {
        throw new ConfigError('ALLOWED_ORIGINS="*" is only permitted with NODE_ENV=development');
      }
      continue;
    }
    if (!/^https?:\/\/[^/\s]+$/.test(origin)) {
      throw new ConfigError(`ALLOWED_ORIGINS entry "${origin}" must be an origin (scheme://host[:port], no path)`);
    }
  }

  const publicOrigin = env["PUBLIC_ORIGIN"]?.trim().replace(/\/+$/, "").toLowerCase() || undefined;
  if (publicOrigin !== undefined && !/^https?:\/\/[^/\s]+$/.test(publicOrigin)) {
    throw new ConfigError(`PUBLIC_ORIGIN must be an origin (scheme://host[:port], no path), got "${publicOrigin}"`);
  }

  const trustProxy = bool(env, "TRUST_PROXY", false);
  const trustedProxyCidrs: Cidr[] = [];
  for (const entry of (env["TRUSTED_PROXY_CIDRS"] ?? "").split(",").map((x) => x.trim()).filter((x) => x.length > 0)) {
    const c = parseCidr(entry);
    if (!c) throw new ConfigError(`TRUSTED_PROXY_CIDRS entry "${entry}" is not an IP or CIDR`);
    trustedProxyCidrs.push(c);
  }
  if (trustProxy && trustedProxyCidrs.length === 0) {
    // Without this, TRUST_PROXY on a directly reachable port makes the
    // per-IP cooldown whatever the client writes into X-Forwarded-For.
    throw new ConfigError("TRUST_PROXY=true requires TRUSTED_PROXY_CIDRS (the proxies' addresses, e.g. 10.0.0.0/8,172.16.0.0/12)");
  }

  const captchaProvider = str(env, "CAPTCHA_PROVIDER", "off");
  if (captchaProvider !== "off" && captchaProvider !== "hcaptcha" && captchaProvider !== "turnstile") {
    throw new ConfigError('CAPTCHA_PROVIDER must be "off", "hcaptcha" or "turnstile"');
  }
  const captchaSecret = env["CAPTCHA_SECRET"]?.trim() || undefined;
  const captchaSiteKey = env["CAPTCHA_SITE_KEY"]?.trim() || undefined;
  if (captchaProvider !== "off" && (captchaSecret === undefined || captchaSiteKey === undefined)) {
    throw new ConfigError("CAPTCHA_SECRET and CAPTCHA_SITE_KEY are required when CAPTCHA_PROVIDER is set");
  }
  // The captcha is the only volumetric control (per-IP cooldowns are
  // keyed by /64 for IPv6, which a hosting customer can rotate). Anything
  // that looks like a public deployment must turn it on, or say out loud
  // that it is not. NODE_ENV unset counts as production, as for CORS above.
  const looksPublic = trustProxy || allowedOrigins.length > 0 || publicOrigin !== undefined || nodeEnv === "production";
  const allowNoCaptcha = bool(env, "ALLOW_NO_CAPTCHA", false);
  if (captchaProvider === "off" && looksPublic && !allowNoCaptcha) {
    throw new ConfigError(
      "CAPTCHA_PROVIDER=off on what looks like a public deployment (TRUST_PROXY, ALLOWED_ORIGINS, PUBLIC_ORIGIN or NODE_ENV=production). " +
        "Set CAPTCHA_PROVIDER=hcaptcha|turnstile, or ALLOW_NO_CAPTCHA=true to run without one (not for a public faucet).",
    );
  }

  const rateLimitStore = str(env, "RATE_LIMIT_STORE", "memory");
  if (rateLimitStore !== "memory" && rateLimitStore !== "redis") {
    throw new ConfigError('RATE_LIMIT_STORE must be "memory" or "redis"');
  }
  const redisUrl = env["REDIS_URL"]?.trim() || undefined;
  if (rateLimitStore === "redis" && redisUrl === undefined) {
    throw new ConfigError("REDIS_URL is required when RATE_LIMIT_STORE=redis");
  }


  // Bech32 prefixes are lowercase by definition (BIP-173); accept any case
  // in the env but normalise, or "Kons" would reject every kons1… input and
  // toBech32 would emit a mixed-case string.
  const bech32Prefix = str(env, "BECH32_PREFIX", "kons").toLowerCase();
  if (!/^[a-z0-9]{1,20}$/.test(bech32Prefix)) {
    throw new ConfigError(`BECH32_PREFIX must be 1–20 alphanumeric characters, got "${bech32Prefix}"`);
  }

  return {
    privateKey,
    rpcUrl,
    chainId,
    bech32Prefix,
    amountKash,
    amountWei,
    cooldownSeconds,
    lowBalanceWei,
    port,
    host,
    allowedOrigins,
    trustProxy,
    trustedProxyHops: int(env, "TRUSTED_PROXY_HOPS", 1, 1, 10),
    trustedProxyCidrs,
    confirmTimeoutMs: int(env, "CONFIRM_TIMEOUT_SECONDS", 20, 1, 300) * 1000,
    lookupWindowMs: int(env, "LOOKUP_WINDOW_SECONDS", 3, 1, 60) * 1000,
    publicOrigin,
    rateLimitStore,
    redisUrl,
    captcha: { provider: captchaProvider, secret: captchaSecret, siteKey: captchaSiteKey },
    allowNoCaptcha,
    networkName: str(env, "NETWORK_NAME", KNOWN_NETWORKS[chainId] ?? `chain ${chainId}`),
    explorerTxUrl: env["EXPLORER_TX_URL"]?.trim() || undefined,
  };
}

/** For logs: everything except the key, and only the RPC host (the URL may carry a token). */
export function describeConfig(c: FaucetConfig): Record<string, unknown> {
  let rpcHost = "<unparseable>";
  try {
    rpcHost = new URL(c.rpcUrl).host;
  } catch {
    // validated at load; unreachable
  }
  return {
    rpcHost,
    chainId: c.chainId,
    amountKash: c.amountKash,
    cooldownSeconds: c.cooldownSeconds,
    port: c.port,
    host: c.host,
    allowedOrigins: c.allowedOrigins,
    trustProxy: c.trustProxy,
    trustedProxyHops: c.trustedProxyHops,
    trustedProxyCidrs: c.trustedProxyCidrs.map((x) => x.text),
    confirmTimeoutMs: c.confirmTimeoutMs,
    lookupWindowMs: c.lookupWindowMs,
    publicOrigin: c.publicOrigin,
    rateLimitStore: c.rateLimitStore,
    captcha: c.captcha.provider,
    networkName: c.networkName,
  };
}
