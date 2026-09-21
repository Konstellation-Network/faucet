# faucet

Token faucet for **Konstellation testnet-1**. Sends a fixed amount of test KASH
to an address, once per address and once per IP per cooldown.

**Testnet-only.** `ENGINEERING.md §18`: "Faucet — required (`faucet` repo) /
does not exist on mainnet". The service refuses to start with `CHAIN_ID=5667`
(konstellation-1). The account it spends from is the testnet "liquidity"
bucket of the genesis allocation (`TOKENOMICS.md §7`, `ENGINEERING.md §18`),
which on testnet-1 is a test address with no value behind it.

This repo is a service, not a binary: `konstellation` is the only repo that
produces an executable (`ENGINEERING.md §5`). It ships as TypeScript run by
Node, or as the Docker image built from the `Dockerfile`.

## What it does

| Route | |
|---|---|
| `GET /` | a one-input page |
| `POST /request` `{ "address": "0x… \| kons1…", "captchaToken"?: "…" }` (`content-type: application/json`) | sends `AMOUNT_KASH`, waits for the receipt, returns `{ txHash, confirmed, to, toBech32, amountKash, chainId }` — `200` once mined, `202` with `confirmed: false` if the receipt did not arrive within `CONFIRM_TIMEOUT_SECONDS` (the tx is broadcast) |
| `GET /healthz` | RPC reachable, chain id matches, block height, faucet balance, `lowBalance` warning; 503 when unhealthy |

`0x…` and `kons1…` are the same account on cosmos/evm (the bech32 string is
the same 20 bytes); the faucet converts bech32 to hex and everything downstream
sees one form. A mixed-case `0x` address must carry a valid EIP-55 checksum.

Every request goes through, in order:

1. **Address parsing** (`src/address.ts`) — bech32 decoded in-house (no dependency).
2. **Blocked-recipient check** (`src/blocked.ts`) — the zero address, every
   module account and every precompile. The chain itself refuses a value
   transfer to these at submission (`konstellation/app/blocked_recipient.go`,
   `STATUS.md §3`); the faucet checks the same set first so a bad request is a
   clear 400 and the liquidity bucket can never be sent somewhere unspendable.
   **The list is a copy of `konstellation/app/config/permissions.go`** — when a
   module account or precompile is added there, add it here. The test re-derives
   every module address from its name, so a typo fails CI, but a missing entry
   does not.
3. **Captcha** (optional, off by default).
4. **Cooldown claims** per address and per client IP (`src/ratelimit.ts`,
   `src/ip.ts`) — taken *before* the send so concurrent requests cannot
   double-spend. IPv4 is keyed by address, IPv6 by its /64; v4-mapped and
   differently-written forms of the same address are one key.
5. **Balance check** against `amount + 21000 × maxFeePerGas`, then one
   **EIP-1559 transfer** via viem (`src/sender.ts`), then a wait for the receipt.

The send has three phases. A failure the node *answered* with (a rejection,
"nonce too low", fee or gas estimation) is **pre-broadcast**: the tx provably
never entered the pool, the cooldown is refunded. A lost response (timeout,
connection error, HTTP 5xx from a proxy) is the one real ambiguity: the
sender then looks the locally-signed tx up by hash for `LOOKUP_WINDOW_SECONDS`
(≥ 2 block intervals — on this chain `eth_getTransactionByHash` only answers
once the tx is included) and, if it appears, reports success with the hash.
Only when it never appears is the result **post-broadcast**: `502` with
`phase: "post-broadcast"`, the `txHash` to look for, and the words "you may
still have been paid — check the explorer; the cooldown stands". The
broadcast is never retried by the transport.

Nonces are a local counter: with the app-side EVM mempool the `pending` nonce
does not move until a block lands, so per-send `eth_getTransactionCount`
collided within one block interval. The counter goes stale whenever anything
else spends the key — a second replica, an operator's manual tx — so a
node-answered nonce complaint resyncs it and retries once *inside the same
request* (two instances alternating on one key every 2 s: every request
`200`). It is also dropped after a receipt wait times out, so an evicted tx
cannot leave a nonce gap until restart.

Errors are JSON: `400 invalid_address | blocked_recipient | bad_request`,
`403 captcha_failed | forbidden_origin`, `415` (not `application/json`),
`429 rate_limited` (with `Retry-After`), `502 send_failed` with
`phase: "pre-broadcast"` (nothing was paid; the node's reason — e.g. a frozen
address, `x/compliance`) or `phase: "post-broadcast"` + `txHash` (may have
been paid, see above), `503 faucet_empty`.

## Configuration

All from the environment. `.env.example` documents every variable; the ones
that matter:

| Variable | Default | |
|---|---|---|
| `FAUCET_PRIVATE_KEY` | — (required) | 32-byte hex. **Secret. Never in a file in this repo.** |
| `RPC_URL` | — (required) | Ethereum JSON-RPC of a testnet-1 RPC node |
| `CHAIN_ID` | `56671` | testnet-1. `56670` = local dev chain. `5667` refused. Startup also checks `eth_chainId` against it and refuses to start on a mismatch. |
| `AMOUNT_KASH` | `10` | **placeholder** until a testnet-1 payout policy is decided. Hard-capped at 1 000 by the service. |
| `COOLDOWN_SECONDS` | `86400` | per address *and* per IP |
| `LOW_BALANCE_KASH` | `100 × AMOUNT_KASH` | `/healthz` reports `degraded` below this |
| `PORT` / `HOST` | `8080` / `0.0.0.0` | |
| `ALLOWED_ORIGINS` | empty | comma-separated origins for cross-origin API calls. The built-in page is same-origin and needs none. A `POST` carrying any other `Origin` is refused (403). `*` is refused unless `NODE_ENV=development`. |
| `PUBLIC_ORIGIN` | — | the origin the page is served from, e.g. `https://faucet.testnet-1.konstellation.network`. Needed only when the proxy rewrites `Host` and does not send `X-Forwarded-Host` (with `TRUST_PROXY` the first `X-Forwarded-Host` entry is also accepted); otherwise "own origin" is judged by the request `Host`. |
| `TRUST_PROXY` | `false` | take the client IP from `X-Forwarded-For`. **Only** behind a proxy you control: with it on and no proxy, the header is client-supplied. |
| `TRUSTED_PROXY_HOPS` | `1` | how many proxies append to `X-Forwarded-For`; the client is that many entries from the *right* (everything further left is client-supplied and ignored). A non-IP in that slot is a 400. |
| `CONFIRM_TIMEOUT_SECONDS` | `20` | how long a request waits for the receipt before answering `202` |
| `LOOKUP_WINDOW_SECONDS` | `3` | after a lost broadcast response: how long to look for the tx by hash before answering post-broadcast |
| `RATE_LIMIT_STORE` | `memory` | `redis` for several replicas (`REDIS_URL`). The `redis` client is an optional dependency: `npm ci` installs it locally, the Docker image includes it only with `--build-arg WITH_REDIS=1`. |
| `CAPTCHA_PROVIDER` | `off` | `hcaptcha` or `turnstile`, with `CAPTCHA_SITE_KEY` + `CAPTCHA_SECRET`. **Off by default — turn it on before the faucet is public.** |
| `EXPLORER_TX_URL` | — | e.g. `https://explorer…/tx/{hash}` for the result link |

## Key handling

- The faucet account is a **dedicated key** holding only what the faucet should
  be able to spend. It is not a validator key, not the dev multisig, not any
  key that exists on konstellation-1.
- It arrives **only** through `FAUCET_PRIVATE_KEY`: a Coolify/Docker secret or
  an env file outside the repo. `.env` is git-ignored; `.env.example` has the
  variable with no value. CI runs `scripts/secret-scan.mjs` over **every commit
  reachable from HEAD** (not just the tree): any 32-byte hex string that is not
  exactly the public dev0 key from `konstellation/local_node.sh` (or an obvious
  placeholder) and any run of 12+ BIP-39 words fails the build.
- Logs never carry the RPC URL (it may hold a token), only its host; RPC error
  text is URL-redacted before it reaches a log or a response.
- Top it up from the liquidity bucket in tranches rather than parking the
  whole bucket on it; `/healthz` says when it is low, and the startup log
  prints the balance.
- Rotate by funding a new key and restarting with the new value. Nothing on
  chain references the faucet address.

## Running

```bash
npm ci
npm run typecheck && npm test      # 92 tests, no network needed (viem runs against an in-memory fake node)
npm run build && FAUCET_PRIVATE_KEY=… RPC_URL=… npm start
# or, during development, with a .env file:
npm run dev
```

Against a local dev chain (`konstellation/local_node.sh -y`, chain id 56670,
JSON-RPC on :8545; the dev mnemonics there are public — `dev0`'s key is the one
in `.env.example`'s comment):

```bash
FAUCET_PRIVATE_KEY=0x88cbead91aee890d27bf06e003ade3d4e952427e88f88d31d61d3ef5e5d54305 \
RPC_URL=http://127.0.0.1:8545 CHAIN_ID=56670 COOLDOWN_SECONDS=30 npm start
curl -s -X POST -H 'content-type: application/json' \
  -d '{"address":"kons1jcltmuhplrdcwp7stlr4hlhlhgd4htqh6f2nqr"}' http://127.0.0.1:8080/request
```

## Deployment

`Dockerfile` builds a small image (`node:22-alpine` pinned by digest, non-root,
no key inside; `--build-arg WITH_REDIS=1` for the multi-replica variant).
`docker-compose.example.yml` shows the intended shape: read-only filesystem,
all capabilities dropped, bound to localhost behind the platform's reverse
proxy. Per `ENGINEERING.md §9.1` the faucet is stateless app-tier and belongs
on Coolify/k8s, never on a validator host. It needs an RPC node's
`eth_sendRawTransaction`; point it at the `infra` RPC node, not a validator or
sentry.

Checklist before it is public:

- [ ] a dedicated faucet key, funded from the testnet liquidity bucket
- [ ] `CAPTCHA_PROVIDER` on, keys set
- [ ] `TRUST_PROXY=true` only if the proxy sets `X-Forwarded-For`, with `TRUSTED_PROXY_HOPS` = the number of proxies in front; `PUBLIC_ORIGIN` if it rewrites `Host` without `X-Forwarded-Host`
- [ ] `ALLOWED_ORIGINS` set only if `docs` or another site will call the API directly
- [ ] `/healthz` wired into monitoring (`infra/monitoring`) — alert on `degraded`
- [ ] `AMOUNT_KASH` / `COOLDOWN_SECONDS` set to the agreed policy (defaults are placeholders)

## Layout

```
src/
├── main.ts        entrypoint (`npm start`)
├── server.ts      node:http routes, CORS, security headers, startup checks
├── faucet.ts      the request pipeline (HTTP-agnostic, fully unit-tested)
├── address.ts     0x / kons1 parsing, bech32 codec
├── ip.ts          X-Forwarded-For hop selection, IPv4/IPv6 canonical keys
├── blocked.ts     module accounts + precompiles + zero address (copy of the chain's list)
├── ratelimit.ts   RateLimitStore interface, memory + redis implementations
├── sender.ts      viem: prepare / broadcast / confirm phases, local nonce counter, fee quote
├── captcha.ts     hCaptcha / Turnstile siteverify
├── config.ts      env parsing and validation
└── page.ts        the static page and its script
test/              vitest; test/fake-rpc.ts is an in-memory JSON-RPC node for the real sender
scripts/           secret-scan.mjs (CI)
```
