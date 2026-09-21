// A tiny in-memory JSON-RPC node behind viem's `custom()` transport, enough
// to drive the real `createViemSender`: EIP-1559 fee data, a pending pool
// that only advances the pending nonce when a block is mined (as the
// app-side mempool behaves), receipts, and hooks to break the broadcast.

import { custom, HttpRequestError, keccak256, parseTransaction, RpcRequestError, TimeoutError, type Hex, type Transport } from "viem";

export interface PoolTx {
  hash: Hex;
  raw: Hex;
  nonce: number;
  to: Hex | undefined;
  value: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  gas: bigint;
}

export interface FakeRpcOptions {
  chainId?: number;
  baseFeePerGas?: bigint;
  priorityFee?: bigint;
  balance?: bigint;
  minedNonce?: number;
}

export class FakeRpc {
  chainId: number;
  baseFeePerGas: bigint;
  priorityFee: bigint;
  balance: bigint;
  blockNumber = 100n;
  /** Next nonce as seen by the chain state (mined txs). */
  minedNonce: number;
  pool: PoolTx[] = [];
  mined = new Map<Hex, { tx: PoolTx; status: "0x1" | "0x0"; block: bigint }>();
  calls: string[] = [];
  /** If set, eth_sendRawTransaction runs this instead of the normal path. */
  onSendRaw: ((raw: Hex, tx: PoolTx) => Hex | Promise<Hex>) | null = null;
  /** Txs that revert when mined. */
  revertHashes = new Set<Hex>();

  constructor(o: FakeRpcOptions = {}) {
    this.chainId = o.chainId ?? 56670;
    this.baseFeePerGas = o.baseFeePerGas ?? 0n;
    this.priorityFee = o.priorityFee ?? 0n;
    this.balance = o.balance ?? 10n ** 24n;
    this.minedNonce = o.minedNonce ?? 0;
  }

  /** Includes every pooled tx in a new block. */
  mineBlock(): void {
    this.blockNumber += 1n;
    const inOrder = [...this.pool].sort((a, b) => a.nonce - b.nonce);
    for (const tx of inOrder) {
      if (tx.nonce !== this.minedNonce) break;
      this.minedNonce++;
      this.mined.set(tx.hash, { tx, status: this.revertHashes.has(tx.hash) ? "0x0" : "0x1", block: this.blockNumber });
      this.pool = this.pool.filter((p) => p !== tx);
    }
  }

  static decode(raw: Hex): PoolTx {
    const t = parseTransaction(raw);
    if (t.type !== "eip1559") throw new Error(`expected eip1559, got ${t.type}`);
    return {
      hash: keccak256(raw),
      raw,
      nonce: t.nonce!,
      to: t.to ?? undefined,
      value: t.value ?? 0n,
      maxFeePerGas: t.maxFeePerGas ?? 0n,
      maxPriorityFeePerGas: t.maxPriorityFeePerGas ?? 0n,
      gas: t.gas ?? 0n,
    };
  }

  rpcError(message: string, code = -32000): never {
    throw new RpcRequestError({ body: {}, error: { code, message }, url: "http://fake" });
  }

  async handle(method: string, params: unknown[]): Promise<unknown> {
    this.calls.push(method);
    const hex = (n: bigint | number) => `0x${n.toString(16)}`;
    switch (method) {
      case "eth_chainId":
        return hex(this.chainId);
      case "eth_blockNumber":
        return hex(this.blockNumber);
      case "eth_getBalance":
        return hex(this.balance);
      case "eth_maxPriorityFeePerGas":
        return hex(this.priorityFee);
      case "eth_gasPrice":
        return hex(this.baseFeePerGas + this.priorityFee);
      case "eth_getBlockByNumber":
        return {
          number: hex(this.blockNumber),
          hash: `0x${"11".repeat(32)}`,
          parentHash: `0x${"22".repeat(32)}`,
          baseFeePerGas: hex(this.baseFeePerGas),
          gasLimit: "0x989680",
          gasUsed: "0x0",
          timestamp: hex(BigInt(Math.floor(Date.now() / 1000))),
          miner: `0x${"00".repeat(20)}`,
          transactions: [],
          uncles: [],
          difficulty: "0x0",
          extraData: "0x",
          logsBloom: `0x${"00".repeat(256)}`,
          nonce: "0x0000000000000000",
          size: "0x0",
          stateRoot: `0x${"33".repeat(32)}`,
          receiptsRoot: `0x${"44".repeat(32)}`,
          transactionsRoot: `0x${"55".repeat(32)}`,
          sha3Uncles: `0x${"66".repeat(32)}`,
          mixHash: `0x${"77".repeat(32)}`,
        };
      case "eth_estimateGas":
        return "0x5208";
      case "eth_getTransactionCount": {
        // `pending` == `latest` until a block lands: the app-side mempool does
        // not advance the pending nonce for queued txs.
        return hex(this.minedNonce);
      }
      case "eth_sendRawTransaction": {
        const raw = params[0] as Hex;
        const tx = FakeRpc.decode(raw);
        if (this.onSendRaw) return this.onSendRaw(raw, tx);
        return this.acceptTx(tx);
      }
      case "eth_getTransactionReceipt": {
        const m = this.mined.get(params[0] as Hex);
        if (!m) return null;
        return {
          transactionHash: m.tx.hash,
          transactionIndex: "0x0",
          blockHash: `0x${"11".repeat(32)}`,
          blockNumber: hex(m.block),
          from: `0x${"00".repeat(20)}`,
          to: m.tx.to ?? null,
          cumulativeGasUsed: "0x5208",
          gasUsed: "0x5208",
          effectiveGasPrice: hex(this.baseFeePerGas + this.priorityFee),
          contractAddress: null,
          logs: [],
          logsBloom: `0x${"00".repeat(256)}`,
          status: m.status,
          type: "0x2",
        };
      }
      case "eth_getTransactionByHash": {
        // As on the real node: with the app-side EVM mempool a queued tx is
        // NOT visible by hash; only an included one is.
        const h = params[0] as Hex;
        const m = this.mined.get(h);
        if (!m) return null;
        const tx = m.tx;
        return {
          hash: tx.hash,
          nonce: hex(tx.nonce),
          blockHash: `0x${"11".repeat(32)}`,
          blockNumber: hex(m.block),
          transactionIndex: "0x0",
          from: `0x${"00".repeat(20)}`,
          to: tx.to ?? null,
          value: hex(tx.value),
          gas: hex(tx.gas),
          gasPrice: hex(tx.maxFeePerGas),
          maxFeePerGas: hex(tx.maxFeePerGas),
          maxPriorityFeePerGas: hex(tx.maxPriorityFeePerGas),
          input: "0x",
          chainId: hex(this.chainId),
          type: "0x2",
          accessList: [],
          v: "0x0",
          r: "0x0",
          s: "0x0",
          yParity: "0x0",
        };
      }
      default:
        throw new Error(`fake rpc: unhandled ${method}`);
    }
  }

  /** The normal node behaviour for a raw tx. */
  acceptTx(tx: PoolTx): Hex {
    if (tx.nonce < this.minedNonce) this.rpcError("nonce too low");
    if (this.pool.some((p) => p.hash === tx.hash)) this.rpcError("already known");
    if (this.pool.some((p) => p.nonce === tx.nonce)) this.rpcError("replacement transaction underpriced");
    if (tx.value + tx.gas * tx.maxFeePerGas > this.balance) this.rpcError("insufficient funds for gas * price + value");
    this.pool.push(tx);
    return tx.hash;
  }

  transport(): Transport {
    return custom({ request: ({ method, params }) => this.handle(method, (params as unknown[]) ?? []) });
  }

  timeout(): never {
    throw new TimeoutError({ body: {}, url: "http://fake" });
  }

  /** An HTTP 5xx from a proxy in front of the node. */
  http502(): never {
    throw new HttpRequestError({ body: {}, url: "http://fake", status: 502, details: "Bad Gateway" });
  }
}
