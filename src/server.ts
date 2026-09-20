// HTTP layer on node:http — no framework, three routes:
//   GET  /         the page (+ GET /app.js)
//   POST /request  { address, captchaToken? } → { txHash, … }
//   GET  /healthz  RPC reachable, chain id matches, faucet balance
//
// `createApp` builds the request handler from injected pieces so tests can
// drive it without a network; `main` wires the real ones from the env.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { formatEther } from "viem";
import { createCaptchaVerifier } from "./captcha.js";
import { ConfigError, describeConfig, loadConfig, type FaucetConfig } from "./config.js";
import { Faucet } from "./faucet.js";
import { APP_JS, contentSecurityPolicy, renderPage } from "./page.js";
import { MemoryRateLimitStore, RedisRateLimitStore, type RateLimitStore } from "./ratelimit.js";
import { createViemSender, type Sender } from "./sender.js";

const MAX_BODY_BYTES = 4 * 1024;

export interface AppDeps {
  config: FaucetConfig;
  faucet: Faucet;
  sender: Sender;
  log: (msg: string, fields?: Record<string, unknown>) => void;
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

/** Client IP: the socket's, or the first X-Forwarded-For hop when TRUST_PROXY is on. */
export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = req.headers["x-forwarded-for"];
    const first = (Array.isArray(xff) ? xff[0] : xff)?.split(",")[0]?.trim();
    if (first) return normaliseIp(first);
  }
  return normaliseIp(req.socket.remoteAddress ?? "unknown");
}

function normaliseIp(ip: string): string {
  // ::ffff:1.2.3.4 → 1.2.3.4 so v4 clients get one key whichever stack they arrive on.
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return m ? m[1]! : ip;
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

  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const cors = corsHeaders(config, req.headers.origin);

    if (req.method === "OPTIONS") {
      res.writeHead(Object.keys(cors).length > 0 ? 204 : 403, cors);
      res.end();
      return;
    }

    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": csp,
        "cache-control": "no-store",
        ...securityHeaders,
      });
      res.end(page);
      return;
    }

    if (req.method === "GET" && url.pathname === "/app.js") {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store", ...securityHeaders });
      res.end(APP_JS);
      return;
    }

    if (req.method === "GET" && url.pathname === "/healthz") {
      try {
        const s = await sender.status();
        const chainOk = s.chainId === config.chainId;
        const low = s.faucetBalanceWei < config.lowBalanceWei;
        const empty = s.faucetBalanceWei < config.amountWei;
        const body = {
          status: !chainOk || empty ? "unhealthy" : low ? "degraded" : "ok",
          rpc: "reachable",
          chainId: s.chainId,
          expectedChainId: config.chainId,
          blockNumber: s.blockNumber.toString(),
          faucetAddress: sender.address,
          faucetBalanceKash: formatEther(s.faucetBalanceWei),
          amountKash: config.amountKash,
          lowBalance: low,
          ...(low ? { warning: `balance below ${formatEther(config.lowBalanceWei)} KASH` } : {}),
          ...(chainOk ? {} : { error: `RPC chain id ${s.chainId} != configured ${config.chainId}` }),
        };
        json(res, body.status === "unhealthy" ? 503 : 200, body, { ...securityHeaders, ...cors });
      } catch (e) {
        log("healthz: rpc unreachable", { error: e instanceof Error ? e.message : String(e) });
        json(res, 503, { status: "unhealthy", rpc: "unreachable", expectedChainId: config.chainId }, { ...securityHeaders, ...cors });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/request") {
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch (e) {
        const msg = e instanceof Error && e.message === "body too large" ? "body too large" : "body must be JSON";
        json(res, 400, { error: msg, code: "bad_request" }, { ...securityHeaders, ...cors });
        return;
      }
      const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
      const result = await faucet.request({ address: b["address"], captchaToken: b["captchaToken"], ip: clientIp(req, config.trustProxy) });
      if (result.ok) {
        const { ok: _ok, ...rest } = result;
        json(res, 200, rest, { ...securityHeaders, ...cors });
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
  // `redis` is deliberately not a dependency of this package: add it
  // (`npm install redis`) in the deployment that needs multi-replica cooldowns.
  const modName = "redis";
  let mod: { createClient: (o: { url: string }) => { connect(): Promise<unknown> } & ConstructorParameters<typeof RedisRateLimitStore>[0] };
  try {
    mod = (await import(modName)) as typeof mod;
  } catch {
    throw new ConfigError('RATE_LIMIT_STORE=redis needs the "redis" package installed (npm install redis)');
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
  });

  // Refuse to start against the wrong chain: the same replay-domain
  // discipline the node applies to its own genesis (ENGINEERING.md §1).
  const status = await sender.status();
  if (status.chainId !== config.chainId) {
    console.error(`RPC ${config.rpcUrl} reports chain id ${status.chainId}, but CHAIN_ID=${config.chainId}; refusing to start`);
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
