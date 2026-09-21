// HTTP layer on node:http — no framework, three routes:
//   GET  /         the page (+ GET /app.js)
//   POST /request  { address, captchaToken? } → { txHash, … }
//   GET  /healthz  RPC reachable, chain id matches, faucet balance
//
// `createApp` builds the request handler from injected pieces so tests can
// drive it without a network; `main` wires the real ones from the env.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { formatEther } from "viem";
import { createCaptchaVerifier } from "./captcha.ts";
import { ConfigError, describeConfig, loadConfig, type FaucetConfig } from "./config.ts";
import { Faucet } from "./faucet.ts";
import { canonicalIp, forwardedClientIp, type CanonicalIp } from "./ip.ts";
import { APP_JS, contentSecurityPolicy, renderPage } from "./page.ts";
import { MemoryRateLimitStore, RedisRateLimitStore, type RateLimitStore } from "./ratelimit.ts";
import { createViemSender, payoutCost, redactUrls, type ChainStatus, type Sender } from "./sender.ts";

const MAX_BODY_BYTES = 4 * 1024;
const HEALTH_CACHE_MS = 5_000;

export interface AppDeps {
  config: FaucetConfig;
  faucet: Faucet;
  sender: Sender;
  log: (msg: string, fields?: Record<string, unknown>) => void;
  /** How long a /healthz result is reused, ms. Default 5 s. */
  healthCacheMs?: number;
}

export type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

function json(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

/**
 * Client IP: the socket peer, or — with TRUST_PROXY — the entry
 * `trustedProxyHops` from the right of X-Forwarded-For (proxies append the
 * peer; everything to the left is client-supplied). Null when the chosen
 * entry is not an IP address, which the caller turns into a 400.
 */
export function clientIp(req: IncomingMessage, trustProxy: boolean, trustedProxyHops = 1): CanonicalIp | null {
  if (trustProxy) {
    return forwardedClientIp(req.headers["x-forwarded-for"], trustedProxyHops);
  }
  return canonicalIp(req.socket.remoteAddress ?? "");
}

/** Scheme-agnostic same-origin check: the Origin's host equals the request Host. */
function isSameOrigin(origin: string, host: string | undefined): boolean {
  if (!host) return false;
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new Error("body too large");
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") return {};
  return JSON.parse(text) as unknown;
}

function corsHeaders(config: FaucetConfig, origin: string | undefined): Record<string, string> {
  if (!origin || config.allowedOrigins.length === 0) return {};
  const allowed = config.allowedOrigins.includes("*") || config.allowedOrigins.includes(origin);
  if (!allowed) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST, GET, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "600",
    vary: "origin",
  };
}

export function createApp(deps: AppDeps): Handler {
  const { config, faucet, sender, log } = deps;
  const healthCacheMs = deps.healthCacheMs ?? HEALTH_CACHE_MS;
  const page = renderPage({
    networkName: config.networkName,
    chainId: config.chainId,
    amountKash: config.amountKash,
    cooldownSeconds: config.cooldownSeconds,
    bech32Prefix: config.bech32Prefix,
    captcha: { provider: config.captcha.provider, siteKey: config.captcha.siteKey },
    explorerTxUrl: config.explorerTxUrl,
  });
  const csp = contentSecurityPolicy(config.captcha.provider);
  const securityHeaders = {
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
  };

  // /healthz is unauthenticated and costs four RPC calls; one status per
  // few seconds is plenty for a monitor and bounds what a scraper can cause.
  let statusCache: { at: number; value: Promise<ChainStatus> } | null = null;
  const cachedStatus = (): Promise<ChainStatus> => {
    const now = Date.now();
    if (statusCache && now - statusCache.at < healthCacheMs) return statusCache.value;
    const value = sender.status();
    statusCache = { at: now, value };
    value.catch(() => {
      if (statusCache?.value === value) statusCache = null;
    });
    return value;
  };

  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const cors = corsHeaders(config, req.headers.origin);

    if (req.method === "OPTIONS") {
      res.writeHead(Object.keys(cors).length > 0 ? 204 : 403, cors);
      res.end();
      return;
    }

    const isGet = req.method === "GET" || req.method === "HEAD";
    const body = (s: string) => (req.method === "HEAD" ? undefined : s);

    if (isGet && url.pathname === "/") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": csp,
        "cache-control": "no-store",
        "content-length": String(Buffer.byteLength(page)),
        ...securityHeaders,
      });
      res.end(body(page));
      return;
    }

    if (isGet && url.pathname === "/app.js") {
      res.writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "no-store",
        "content-length": String(Buffer.byteLength(APP_JS)),
        ...securityHeaders,
      });
      res.end(body(APP_JS));
      return;
    }

    if (isGet && url.pathname === "/healthz") {
      try {
        const s = await cachedStatus();
        const chainOk = s.chainId === config.chainId;
        const low = s.faucetBalanceWei < config.lowBalanceWei;
        const empty = s.faucetBalanceWei < payoutCost(config.amountWei, s.maxFeePerGas);
        const body = {
          status: !chainOk || empty ? "unhealthy" : low ? "degraded" : "ok",
          rpc: "reachable",
          chainId: s.chainId,
          expectedChainId: config.chainId,
          blockNumber: s.blockNumber.toString(),
          faucetAddress: sender.address,
          faucetBalanceKash: formatEther(s.faucetBalanceWei),
          amountKash: config.amountKash,
          maxFeePerGas: s.maxFeePerGas.toString(),
          lowBalance: low,
          ...(low ? { warning: `balance below ${formatEther(config.lowBalanceWei)} KASH` } : {}),
          ...(chainOk ? {} : { error: `RPC chain id ${s.chainId} != configured ${config.chainId}` }),
        };
        json(res, body.status === "unhealthy" ? 503 : 200, body, { ...securityHeaders, ...cors });
      } catch (e) {
        log("healthz: rpc unreachable", { error: redactUrls(e instanceof Error ? e.message : String(e)) });
        json(res, 503, { status: "unhealthy", rpc: "unreachable", expectedChainId: config.chainId }, { ...securityHeaders, ...cors });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/request") {
      const hdrs = { ...securityHeaders, ...cors };
      // A cross-site "simple" request (text/plain, no preflight) must not be
      // able to spend a visitor's cooldown: require the JSON content type
      // (which forces a preflight) and refuse a foreign Origin outright.
      const ct = (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
      if (ct !== "application/json") {
        json(res, 415, { error: "content-type must be application/json", code: "bad_request" }, hdrs);
        return;
      }
      const origin = req.headers.origin;
      if (origin !== undefined && Object.keys(cors).length === 0 && !isSameOrigin(origin, req.headers.host)) {
        json(res, 403, { error: "origin not allowed", code: "forbidden_origin" }, hdrs);
        return;
      }
      const ip = clientIp(req, config.trustProxy, config.trustedProxyHops);
      if (ip === null) {
        json(res, 400, { error: "could not determine client address", code: "bad_request" }, hdrs);
        return;
      }

      let parsed: unknown;
      try {
        parsed = await readJsonBody(req);
      } catch (e) {
        const msg = e instanceof Error && e.message === "body too large" ? "body too large" : "body must be JSON";
        json(res, 400, { error: msg, code: "bad_request" }, hdrs);
        return;
      }
      const b = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<string, unknown>;
      const result = await faucet.request({ address: b["address"], captchaToken: b["captchaToken"], ip: ip.key, clientAddress: ip.address });
      if (result.ok) {
        const { ok: _ok, ...rest } = result;
        json(res, result.confirmed ? 200 : 202, rest, hdrs);
      } else {
        const extra: Record<string, string> = { ...securityHeaders, ...cors };
        if (result.retryAfterSeconds !== undefined) extra["retry-after"] = String(result.retryAfterSeconds);
        json(res, result.status, { error: result.error, code: result.code, ...(result.retryAfterSeconds !== undefined ? { retryAfterSeconds: result.retryAfterSeconds } : {}) }, extra);
      }
      return;
    }

    json(res, 404, { error: "not found" }, securityHeaders);
  };
}

async function buildStore(config: FaucetConfig): Promise<RateLimitStore> {
  if (config.rateLimitStore === "memory") return new MemoryRateLimitStore();
  // `redis` is an optional dependency: installed by `npm ci` (so the shipped
  // image supports this mode) but loaded only when this mode is selected.
  const modName = "redis";
  let mod: { createClient: (o: { url: string }) => { connect(): Promise<unknown> } & ConstructorParameters<typeof RedisRateLimitStore>[0] };
  try {
    mod = (await import(modName)) as typeof mod;
  } catch {
    throw new ConfigError('RATE_LIMIT_STORE=redis but the optional "redis" package is not installed (npm ci without --omit=optional)');
  }
  const client = mod.createClient({ url: config.redisUrl! });
  await client.connect();
  return new RedisRateLimitStore(client);
}

export async function main(): Promise<void> {
  const log = (msg: string, fields: Record<string, unknown> = {}) => {
    console.log(JSON.stringify({ ts: new Date().toISOString(), msg, ...fields }));
  };

  let config: FaucetConfig;
  try {
    config = loadConfig();
  } catch (e) {
    console.error(`config error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }

  const sender = createViemSender({
    privateKey: config.privateKey,
    rpcUrl: config.rpcUrl,
    chainId: config.chainId,
    networkName: config.networkName,
    confirmTimeoutMs: config.confirmTimeoutMs,
  });

  // Refuse to start against the wrong chain: the same replay-domain
  // discipline the node applies to its own genesis (ENGINEERING.md §1).
  const status = await sender.status();
  if (status.chainId !== config.chainId) {
    console.error(`RPC reports chain id ${status.chainId}, but CHAIN_ID=${config.chainId}; refusing to start`);
    process.exit(2);
  }
  log("faucet starting", {
    ...describeConfig(config),
    faucetAddress: sender.address,
    faucetBalanceKash: formatEther(status.faucetBalanceWei),
    blockNumber: status.blockNumber.toString(),
  });
  if (status.faucetBalanceWei < config.lowBalanceWei) {
    log("warning: faucet balance is low", { faucetBalanceKash: formatEther(status.faucetBalanceWei) });
  }

  const store = await buildStore(config);
  const faucet = new Faucet({
    sender,
    store,
    captcha: createCaptchaVerifier(config.captcha.provider, config.captcha.secret),
    chainId: config.chainId,
    amountWei: config.amountWei,
    amountKash: config.amountKash,
    cooldownSeconds: config.cooldownSeconds,
    bech32Prefix: config.bech32Prefix,
    log,
  });

  const handler = createApp({ config, faucet, sender, log });
  const server = createServer((req, res) => {
    handler(req, res).catch((e: unknown) => {
      log("unhandled error", { error: e instanceof Error ? e.message : String(e) });
      if (!res.headersSent) json(res, 500, { error: "internal error" });
      else res.end();
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;

  server.listen(config.port, config.host, () => {
    log("listening", { host: config.host, port: config.port });
  });

  const shutdown = (signal: string) => {
    log("shutting down", { signal });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}
