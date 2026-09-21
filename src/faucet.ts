// The request pipeline, independent of HTTP: validate → captcha → blocked
// list → cooldown claims → balance check → send. Returns a typed result
// the server maps to a status code.

import { AddressError, parseAddress, toBech32, type HexAddress } from "./address.ts";
import { blockedReason } from "./blocked.ts";
import type { CaptchaVerifier } from "./captcha.ts";
import { claimCooldown, RateLimitedError, type RateLimitStore } from "./ratelimit.ts";
import { payoutCost, redactUrls, SendError, type Sender } from "./sender.ts";

export interface FaucetOptions {
  sender: Sender;
  store: RateLimitStore;
  captcha: CaptchaVerifier;
  chainId: number;
  amountWei: bigint;
  amountKash: string;
  cooldownSeconds: number;
  bech32Prefix: string;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
}

export interface FaucetRequest {
  address: unknown;
  captchaToken?: unknown;
  /** Rate-limit key for the client (IPv4 address or IPv6 /64, see ip.ts). */
  ip: string;
  /** The client's full address, for the captcha provider. Defaults to `ip`. */
  clientAddress?: string;
}

export type FaucetResult =
  | { ok: true; txHash: `0x${string}`; confirmed: boolean; to: HexAddress; toBech32: string; amountKash: string; chainId: number }
  | {
      ok: false;
      status: number;
      code: FaucetErrorCode;
      error: string;
      retryAfterSeconds?: number;
      /** For send_failed: whether the payout provably did not happen. */
      phase?: "pre-broadcast" | "post-broadcast";
      /** For a post-broadcast failure: the hash to look for in the explorer. */
      txHash?: `0x${string}`;
    };

export type FaucetErrorCode =
  | "invalid_address"
  | "blocked_recipient"
  | "captcha_failed"
  | "rate_limited"
  | "faucet_empty"
  | "send_failed";

export class Faucet {
  private readonly opts: FaucetOptions;
  private readonly log: NonNullable<FaucetOptions["log"]>;

  constructor(opts: FaucetOptions) {
    this.opts = opts;
    this.log = opts.log ?? (() => undefined);
  }

  async request(req: FaucetRequest): Promise<FaucetResult> {
    let to: HexAddress;
    try {
      to = parseAddress(req.address, this.opts.bech32Prefix);
    } catch (e) {
      const msg = e instanceof AddressError ? e.message : "invalid address";
      return { ok: false, status: 400, code: "invalid_address", error: msg };
    }

    const reason = blockedReason(to);
    if (reason !== null) {
      return {
        ok: false,
        status: 400,
        code: "blocked_recipient",
        error: `${to} cannot receive funds: it is ${reason}`,
      };
    }
    if (to.toLowerCase() === this.opts.sender.address.toLowerCase()) {
      return { ok: false, status: 400, code: "blocked_recipient", error: "that is the faucet's own address" };
    }

    if (!(await this.opts.captcha.verify(typeof req.captchaToken === "string" ? req.captchaToken : undefined, req.clientAddress ?? req.ip))) {
      return { ok: false, status: 403, code: "captcha_failed", error: "captcha verification failed" };
    }

    let cooldown;
    try {
      cooldown = await claimCooldown(this.opts.store, to, req.ip, this.opts.cooldownSeconds);
    } catch (e) {
      if (e instanceof RateLimitedError) {
        return {
          ok: false,
          status: 429,
          code: "rate_limited",
          error:
            e.scope === "address"
              ? `this address already received funds; retry in ${e.retryAfterSeconds}s`
              : `this IP already requested funds; retry in ${e.retryAfterSeconds}s`,
          retryAfterSeconds: e.retryAfterSeconds,
        };
      }
      throw e;
    }

    // ---- pre-broadcast: a failure here provably paid nothing, refund the cooldown ----
    try {
      const { faucetBalanceWei, maxFeePerGas } = await this.opts.sender.status();
      if (faucetBalanceWei < payoutCost(this.opts.amountWei, maxFeePerGas)) {
        await cooldown.release();
        this.log("faucet empty", { balanceWei: faucetBalanceWei.toString(), maxFeePerGas: maxFeePerGas.toString() });
        return { ok: false, status: 503, code: "faucet_empty", error: "the faucet is out of funds; try again later" };
      }
    } catch (e) {
      await cooldown.release();
      this.log("status failed", { to, ip: req.ip, error: describe(e) });
      return { ok: false, status: 502, code: "send_failed", error: "send failed: the node did not answer" };
    }

    // ---- send: only a SendError that says "pre-broadcast" gets the cooldown back.
    // A timeout, a 5xx, "already known", "nonce too low" or anything unexpected
    // may mean the payout is already in the mempool (PR #1 review HIGH-1). ----
    try {
      const { txHash, confirmed } = await this.opts.sender.send(to, this.opts.amountWei);
      this.log(confirmed ? "sent" : "broadcast, unconfirmed", { to, ip: req.ip, txHash, amountKash: this.opts.amountKash });
      return {
        ok: true,
        txHash,
        confirmed,
        to,
        toBech32: toBech32(to, this.opts.bech32Prefix),
        amountKash: this.opts.amountKash,
        chainId: this.opts.chainId,
      };
    } catch (e) {
      const phase = e instanceof SendError ? e.phase : "post-broadcast";
      const txHash = e instanceof SendError ? e.txHash : undefined;
      const reason = describe(e).slice(0, 300);
      this.log("send failed", { to, ip: req.ip, phase, txHash, error: reason });
      if (phase === "pre-broadcast") {
        await cooldown.release();
        // The chain's own refusal reasons (blocked recipient, frozen address —
        // STATUS.md §3) are worth showing; the RPC URL and stack never are.
        return { ok: false, status: 502, code: "send_failed", phase, error: `send failed: ${reason}` };
      }
      // The node may have taken the tx before the response was lost and the
      // lookup window did not see it. Say so: the cooldown stands either way.
      return {
        ok: false,
        status: 502,
        code: "send_failed",
        phase,
        ...(txHash !== undefined ? { txHash } : {}),
        error:
          `the node did not answer the broadcast (${reason}); you may still have been paid` +
          (txHash !== undefined ? ` — check the explorer for ${txHash}` : "") +
          `. The cooldown stands.`,
      };
    }
  }
}

function describe(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return redactUrls(msg.split("\n")[0] ?? "error");
}
