// The request pipeline, independent of HTTP: validate → captcha → blocked
// list → cooldown claims → balance check → send. Returns a typed result
// the server maps to a status code.

import { AddressError, parseAddress, toBech32, type HexAddress } from "./address.js";
import { blockedReason } from "./blocked.js";
import type { CaptchaVerifier } from "./captcha.js";
import { claimCooldown, RateLimitedError, type RateLimitStore } from "./ratelimit.js";
import type { Sender } from "./sender.js";

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
  ip: string;
}

export type FaucetResult =
  | { ok: true; txHash: `0x${string}`; to: HexAddress; toBech32: string; amountKash: string; chainId: number }
  | { ok: false; status: number; code: FaucetErrorCode; error: string; retryAfterSeconds?: number };

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

    if (!(await this.opts.captcha.verify(typeof req.captchaToken === "string" ? req.captchaToken : undefined, req.ip))) {
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

    try {
      const { faucetBalanceWei } = await this.opts.sender.status();
      if (faucetBalanceWei < this.opts.amountWei) {
        await cooldown.release();
        this.log("faucet empty", { balanceWei: faucetBalanceWei.toString() });
        return { ok: false, status: 503, code: "faucet_empty", error: "the faucet is out of funds; try again later" };
      }

      const txHash = await this.opts.sender.send(to, this.opts.amountWei);
      this.log("sent", { to, ip: req.ip, txHash, amountKash: this.opts.amountKash });
      return {
        ok: true,
        txHash,
        to,
        toBech32: toBech32(to, this.opts.bech32Prefix),
        amountKash: this.opts.amountKash,
        chainId: this.opts.chainId,
      };
    } catch (e) {
      await cooldown.release();
      const msg = e instanceof Error ? e.message : String(e);
      this.log("send failed", { to, ip: req.ip, error: msg });
      // The chain's own refusal reasons (blocked recipient, frozen address —
      // STATUS.md §3) come back as RPC errors; surface the first line so the
      // user sees why, but never the RPC URL or a stack.
      const firstLine = msg.split("\n")[0] ?? "send failed";
      return { ok: false, status: 502, code: "send_failed", error: `send failed: ${firstLine.slice(0, 300)}` };
    }
  }
}
