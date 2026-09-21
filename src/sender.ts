// The one place that talks to the chain. Everything above it depends on the
// `Sender` interface so it can be mocked in tests.
//
// A send has three phases, and the caller needs to know which one failed:
//
//   prepare    fees, gas, nonce, local signature           — nothing left the process
//   broadcast  eth_sendRawTransaction, retryCount 0        — the node may have it
//   confirm    poll for the receipt                         — the node has it
//
// A `SendError` with `phase: "pre-broadcast"` means the payout provably did
// not happen and the caller may refund the user's cooldown. With the
// broadcast never retried by the transport, a rejection the node *answered*
// with is always pre-broadcast: nothing entered the pool. The only true
// ambiguity is transport loss (timeout, connection error, HTTP 5xx) — the
// node may have taken the tx before the response was lost. That is
// "post-broadcast": the signed tx is looked up by hash for a couple of
// block intervals (on this chain `eth_getTransactionByHash` only answers
// after inclusion), a hit is a success, a miss keeps the cooldown (the
// first PR #1 review turned these into repeat payouts).
//
// Nonces are a local counter, not `eth_getTransactionCount(pending)` per
// send: with the app-side EVM mempool the pending count only moves when a
// block lands, so two sends inside one block interval collided on the same
// nonce (review HIGH-3). The counter goes stale whenever anything else
// spends the key (a second replica, an operator's manual tx), so a
// node-answered nonce complaint resyncs it and retries prepare+broadcast
// once inside the same request; a second failure is a pre-broadcast error.
// The counter is also dropped after a receipt wait times out (an evicted tx
// would otherwise leave a nonce gap until restart).

import {
  BaseError,
  createPublicClient,
  defineChain,
  http,
  keccak256,
  RpcRequestError,
  TransactionReceiptNotFoundError,
  type Chain,
  type Hex,
  type Transport,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { HexAddress } from "./address.ts";

/** Gas for a plain value transfer to an EOA; used for the affordability check. */
export const TRANSFER_GAS = 21_000n;

export interface ChainStatus {
  chainId: number;
  blockNumber: bigint;
  faucetBalanceWei: bigint;
  /** What the next transfer would pay per gas at most (EIP-1559 estimate). */
  maxFeePerGas: bigint;
}

export interface SendResult {
  txHash: Hex;
  /** true once a successful receipt was seen; false if the receipt wait timed out (tx is broadcast). */
  confirmed: boolean;
}

export type SendPhase = "pre-broadcast" | "post-broadcast";

export class SendError extends Error {
  override readonly name = "SendError";
  readonly phase: SendPhase;
  readonly txHash: Hex | undefined;

  constructor(phase: SendPhase, message: string, txHash?: Hex, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.phase = phase;
    this.txHash = txHash;
  }
}

export interface Sender {
  readonly address: HexAddress;
  /** Sends `valueWei` to `to` as an EIP-1559 transaction. Throws SendError. */
  send(to: HexAddress, valueWei: bigint): Promise<SendResult>;
  status(): Promise<ChainStatus>;
}

/** Cost of one payout including gas at the quoted fee. */
export function payoutCost(amountWei: bigint, maxFeePerGas: bigint): bigint {
  return amountWei + TRANSFER_GAS * maxFeePerGas;
}

export function konstellationChain(chainId: number, rpcUrl: string, name: string): Chain {
  return defineChain({
    id: chainId,
    name: `Konstellation ${name}`,
    nativeCurrency: { name: "KASH", symbol: "KASH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

export interface ViemSenderOptions {
  privateKey: Hex;
  rpcUrl: string;
  chainId: number;
  networkName: string;
  /** Per-request RPC timeout, ms. */
  timeoutMs?: number;
  /** How long to wait for a receipt before answering "broadcast, unconfirmed", ms. */
  confirmTimeoutMs?: number;
  /** Receipt polling interval, ms. */
  pollIntervalMs?: number;
  /** After a lost broadcast response: how long to look for the tx by hash, ms (≥ 2 block intervals). */
  lookupWindowMs?: number;
  /** Test hook: replaces the HTTP transports (reads and the send alike). */
  transport?: Transport;
}

/** Any nonce complaint: the local counter is stale, resync it and retry once. */
const NONCE_ERROR = /nonce too low|nonce too high|invalid nonce|already known|already exists|known transaction|replacement transaction underpriced|tx already in mempool/i;
/** "This exact tx is already in the pool": only believed if a lookup finds the hash. */
const ALREADY_KNOWN = /already known|already exists|known transaction|tx already in mempool/i;

/**
 * Strips anything that looks like a URL — http(s), redis://, anything with a
 * scheme — so an endpoint carrying a token or password never reaches a log
 * or a user. viem strips userinfo from its own messages, not path/query.
 */
export function redactUrls(s: string): string {
  return s.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, "<url>");
}

function firstLine(e: unknown): string {
  // For a viem error the node's own words are in `details`; `shortMessage`
  // is viem's generic wrapper ("RPC Request failed.").
  const msg = e instanceof BaseError ? e.details || e.shortMessage || e.message : e instanceof Error ? e.message : String(e);
  return redactUrls(msg.split("\n")[0] ?? "error").trim();
}

/** The JSON-RPC error the node answered with, if it answered at all. */
function rpcError(e: unknown): RpcRequestError | null {
  if (!(e instanceof BaseError)) return null;
  const found = e.walk((err) => err instanceof RpcRequestError);
  return found instanceof RpcRequestError ? found : null;
}

export function createViemSender(opts: ViemSenderOptions): Sender {
  const chain = konstellationChain(opts.chainId, opts.rpcUrl, opts.networkName);
  const timeout = opts.timeoutMs ?? 15_000;
  const confirmTimeoutMs = opts.confirmTimeoutMs ?? 20_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 500;
  const lookupWindowMs = opts.lookupWindowMs ?? 3_000;
  const account = privateKeyToAccount(opts.privateKey);

  // Reads may retry; the broadcast must not, or a 5xx replays the signed tx.
  const readClient = createPublicClient({
    chain,
    transport: opts.transport ?? http(opts.rpcUrl, { timeout, retryCount: 1 }),
  });
  const sendClient = createPublicClient({
    chain,
    transport: opts.transport ?? http(opts.rpcUrl, { timeout, retryCount: 0 }),
  });

  let nextNonce: number | null = null;
  // prepare + broadcast are serialised so nonces are handed out in order;
  // the receipt wait runs outside the queue so sends overlap in the mempool.
  let queue: Promise<unknown> = Promise.resolve();

  async function syncNonce(): Promise<number> {
    nextNonce = await readClient.getTransactionCount({ address: account.address, blockTag: "pending" });
    return nextNonce;
  }

  /**
   * One attempt at prepare + broadcast. `attempt` > 0 means the nonce was
   * just resynced after a node-answered nonce complaint.
   */
  async function prepareAndBroadcast(to: HexAddress, valueWei: bigint, attempt = 0): Promise<Hex> {
    // ---- prepare: any failure here is provably pre-broadcast ----
    let raw: Hex;
    let hash: Hex;
    let nonce: number;
    try {
      const [fees, gas, n] = await Promise.all([
        readClient.estimateFeesPerGas({ type: "eip1559" }),
        readClient.estimateGas({ account: account.address, to, value: valueWei }),
        nextNonce === null ? syncNonce() : Promise.resolve(nextNonce),
      ]);
      nonce = n;
      raw = await account.signTransaction({
        chainId: opts.chainId,
        type: "eip1559",
        to,
        value: valueWei,
        nonce,
        gas,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      });
      hash = keccak256(raw);
    } catch (e) {
      throw new SendError("pre-broadcast", firstLine(e), undefined, e);
    }

    // ---- broadcast ----
    try {
      // retryCount 0 here as well as on the transport: a retried broadcast
      // after a lost response is how HIGH-1 paid twice.
      const returned = await sendClient.request({ method: "eth_sendRawTransaction", params: [raw] }, { retryCount: 0 });
      nextNonce = nonce + 1;
      return returned ?? hash;
    } catch (e) {
      const rpc = rpcError(e);
      if (rpc !== null) {
        // The node answered: this tx did not enter the pool.
        if (ALREADY_KNOWN.test(rpc.message)) {
          // …unless the node means it literally. Believe it only on sight.
          const known = await pollLookup(hash);
          if (known !== null) {
            nextNonce = known + 1;
            return hash;
          }
        }
        if (NONCE_ERROR.test(rpc.message)) {
          nextNonce = null;
          if (attempt === 0) return prepareAndBroadcast(to, valueWei, 1);
        }
        throw new SendError("pre-broadcast", firstLine(rpc), hash, e);
      }
      // Transport loss: the node may have taken the tx. Look for it by hash
      // across a couple of block intervals before giving up.
      nextNonce = null;
      const known = await pollLookup(hash);
      if (known !== null) {
        nextNonce = known + 1;
        return hash;
      }
      throw new SendError("post-broadcast", firstLine(e), hash, e);
    }
  }

  /** Nonce of the tx if the node knows it, else null. Never throws. */
  async function lookupTransaction(hash: Hex): Promise<number | null> {
    try {
      const tx = await readClient.getTransaction({ hash });
      return tx.nonce;
    } catch {
      return null;
    }
  }

  /** lookupTransaction, repeated for `lookupWindowMs`. */
  async function pollLookup(hash: Hex): Promise<number | null> {
    const deadline = Date.now() + lookupWindowMs;
    for (;;) {
      const found = await lookupTransaction(hash);
      if (found !== null) return found;
      if (Date.now() >= deadline) return null;
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
  }

  /** No receipt in time: the tx may be evicted, so the counter must not assume it. */
  function unconfirmed(hash: Hex): SendResult {
    nextNonce = null;
    return { txHash: hash, confirmed: false };
  }

  async function waitForReceipt(hash: Hex): Promise<SendResult> {
    const deadline = Date.now() + confirmTimeoutMs;
    for (;;) {
      try {
        const receipt = await readClient.getTransactionReceipt({ hash });
        if (receipt.status === "success") return { txHash: hash, confirmed: true };
        throw new SendError("post-broadcast", "transaction reverted", hash);
      } catch (e) {
        if (e instanceof SendError) throw e;
        const notFound = e instanceof BaseError && e.walk((err) => err instanceof TransactionReceiptNotFoundError);
        if (!notFound) {
          // RPC trouble while polling: the tx is broadcast regardless.
          if (Date.now() >= deadline) return unconfirmed(hash);
        }
      }
      if (Date.now() >= deadline) return unconfirmed(hash);
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
  }

  return {
    address: account.address,

    send(to, valueWei) {
      const run = () => prepareAndBroadcast(to, valueWei);
      const broadcast = queue.then(run, run);
      queue = broadcast.catch(() => undefined);
      return broadcast.then(waitForReceipt);
    },

    async status() {
      const [chainId, blockNumber, faucetBalanceWei, fees] = await Promise.all([
        readClient.getChainId(),
        readClient.getBlockNumber(),
        readClient.getBalance({ address: account.address }),
        readClient.estimateFeesPerGas({ type: "eip1559" }),
      ]);
      return { chainId, blockNumber, faucetBalanceWei, maxFeePerGas: fees.maxFeePerGas };
    },
  };
}
