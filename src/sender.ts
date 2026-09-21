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
// not happen and the caller may refund the user's cooldown. Anything after
// that is "post-broadcast": a timeout on the broadcast response, an HTTP 5xx,
// "already known", "nonce too low" — all of which the PR #1 review turned
// into repeat payouts by treating them as failures. Those keep the cooldown.
//
// Nonces are a local counter, not `eth_getTransactionCount(pending)` per
// send: with the app-side EVM mempool the pending count only moves when a
// block lands, so two sends inside one block interval collided on the same
// nonce (review HIGH-3). The counter is fetched once, advanced on every
// successful broadcast, and resynced from the node after any nonce-related
// or ambiguous error.

import {
  BaseError,
  createPublicClient,
  defineChain,
  http,
  keccak256,
  RpcRequestError,
  TransactionNotFoundError,
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
  /** Test hook: replaces the HTTP transports (reads and the send alike). */
  transport?: Transport;
}

/** Any nonce complaint: the local counter is stale, resync it. */
const NONCE_ERROR = /nonce too low|nonce too high|invalid nonce|already known|already exists|known transaction|replacement transaction underpriced|tx already in mempool/i;
/** Complaints that mean *this or an earlier broadcast* is already in the pool — never refund on these. */
const MAYBE_IN_POOL = /nonce too low|already known|already exists|known transaction|tx already in mempool/i;

/** Strips anything that looks like a URL so the RPC endpoint (which may carry a token) never reaches a log or a user. */
export function redactUrls(s: string): string {
  return s.replace(/https?:\/\/[^\s"']+/g, "<rpc>");
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

  async function prepareAndBroadcast(to: HexAddress, valueWei: bigint): Promise<Hex> {
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
        if (NONCE_ERROR.test(rpc.message)) nextNonce = null;
        if (!MAYBE_IN_POOL.test(rpc.message)) {
          // The node answered and rejected it (ante refusal, insufficient
          // funds, frozen address, stale nonce…): nothing entered the mempool.
          throw new SendError("pre-broadcast", firstLine(rpc), hash, e);
        }
      } else {
        // Timeout, connection error, HTTP 5xx: the node may have accepted
        // the tx before the response was lost.
        nextNonce = null;
      }
      // Look for the tx by hash before deciding what to tell the caller.
      const known = await lookupTransaction(hash);
      if (known !== null) {
        nextNonce = known + 1;
        return hash;
      }
      throw new SendError("post-broadcast", firstLine(rpc ?? e), hash, e);
    }
  }

  /** Nonce of the tx if the node knows it, else null. Never throws. */
  async function lookupTransaction(hash: Hex): Promise<number | null> {
    try {
      const tx = await readClient.getTransaction({ hash });
      return tx.nonce;
    } catch (e) {
      if (e instanceof BaseError && e.walk((err) => err instanceof TransactionNotFoundError)) return null;
      return null;
    }
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
          if (Date.now() >= deadline) return { txHash: hash, confirmed: false };
        }
      }
      if (Date.now() >= deadline) return { txHash: hash, confirmed: false };
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
