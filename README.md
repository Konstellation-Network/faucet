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
| `POST /request` `{ "address": "0x… \| kons1…", "captchaToken"?: "…" }` | sends `AMOUNT_KASH`, returns `{ txHash, to, toBech32, amountKash, chainId }` |
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
4. **Cooldown claims** per address and per IP (`src/ratelimit.ts`) — taken
   *before* the send so concurrent requests cannot double-spend, released again
   if the send fails so an RPC hiccup does not lock a user out for a day.
5. **Balance check**, then one **EIP-1559 transfer** via viem (`src/sender.ts`),
   sends serialised so nonces never race.

Errors are JSON: `400 invalid_address | blocked_recipient`, `403 captcha_failed`,
`429 rate_limited` (with `Retry-After`), `502 send_failed` (first line of the
node's reason — e.g. a frozen address, `x/compliance`), `503 faucet_empty`.

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
| `ALLOWED_ORIGINS` | empty | comma-separated origins for cross-origin API calls. The built-in page is same-origin and needs none. `*` is refused unless `NODE_ENV=development`. |
| `TRUST_PROXY` | `false` | take the client IP from `X-Forwarded-For`. Only behind a proxy you control, else the per-IP limit is spoofable. |
| `RATE_LIMIT_STORE` | `memory` | `redis` for several replicas (`REDIS_URL`; `npm install redis` in that deployment — not a default dependency) |
| `CAPTCHA_PROVIDER` | `off` | `hcaptcha` or `turnstile`, with `CAPTCHA_SITE_KEY` + `CAPTCHA_SECRET`. **Off by default — turn it on before the faucet is public.** |
| `EXPLORER_TX_URL` | — | e.g. `https://explorer…/tx/{hash}` for the result link |

## Key handling

- The faucet account is a **dedicated key** holding only what the faucet should
  be able to spend. It is not a validator key, not the dev multisig, not any
  key that exists on konstellation-1.
- It arrives **only** through `FAUCET_PRIVATE_KEY`: a Coolify/Docker secret or
  an env file outside the repo. `.env` is git-ignored; `.env.example` has the
  variable with no value; CI greps every commit for 64-hex strings and fails on
  anything that is not the public dev0 key from `konstellation/local_node.sh`.
- Top it up from the liquidity bucket in tranches rather than parking the
  whole bucket on it; `/healthz` says when it is low, and the startup log
  prints the balance.
- Rotate by funding a new key and restarting with the new value. Nothing on
  chain references the faucet address.

## Running

```bash
npm ci
npm run typecheck && npm test      # 47 tests, no network needed
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

`Dockerfile` builds a small image (`node:22-alpine`, non-root, no key inside).
`docker-compose.example.yml` shows the intended shape: read-only filesystem,
all capabilities dropped, bound to localhost behind the platform's reverse
proxy. Per `ENGINEERING.md §9.1` the faucet is stateless app-tier and belongs
on Coolify/k8s, never on a validator host. It needs an RPC node's
`eth_sendRawTransaction`; point it at the `infra` RPC node, not a validator or
sentry.

Checklist before it is public:

- [ ] a dedicated faucet key, funded from the testnet liquidity bucket
- [ ] `CAPTCHA_PROVIDER` on, keys set
- [ ] `TRUST_PROXY=true` only if the proxy sets `X-Forwarded-For`
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
├── blocked.ts     module accounts + precompiles + zero address (copy of the chain's list)
├── ratelimit.ts   RateLimitStore interface, memory + redis implementations
├── sender.ts      viem: EIP-1559 send, chain status
├── captcha.ts     hCaptcha / Turnstile siteverify
├── config.ts      env parsing and validation
└── page.ts        the static page and its script
test/              vitest; a mocked Sender stands in for the chain
```
