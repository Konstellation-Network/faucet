import { describe, expect, it } from "vitest";
import { parseEther, parseGwei } from "viem";
import { createViemSender, payoutCost, SendError, TRANSFER_GAS } from "../src/sender.ts";
import { FakeRpc } from "./fake-rpc.ts";

const KEY = "0x88cbead91aee890d27bf06e003ade3d4e952427e88f88d31d61d3ef5e5d54305"; // dev0, public
const DEV1 = "0x963EBDf2e1f8DB8707D05FC75bfeFFBa1B5BaC17";

function build(rpc: FakeRpc, extra: Partial<Parameters<typeof createViemSender>[0]> = {}) {
  return createViemSender({
    privateKey: KEY,
    rpcUrl: "http://fake",
    chainId: rpc.chainId,
    networkName: "test",
    transport: rpc.transport(),
    confirmTimeoutMs: 400,
    pollIntervalMs: 10,
    lookupWindowMs: 300,
    ...extra,
  });
}

/** Mines a block every `everyMs` until stopped. */
function miner(rpc: FakeRpc, everyMs = 30): () => void {
  const t = setInterval(() => rpc.mineBlock(), everyMs);
  return () => clearInterval(t);
}

describe("viem sender: fees", () => {
  it("prices the transfer from a non-zero base fee and eth_maxPriorityFeePerGas", async () => {
    const rpc = new FakeRpc({ baseFeePerGas: parseGwei("10"), priorityFee: parseGwei("2") });
    const sender = build(rpc);
    const stop = miner(rpc);
    try {
      const r = await sender.send(DEV1, parseEther("10"));
      expect(r.confirmed).toBe(true);
      const tx = rpc.mined.get(r.txHash)!.tx;
      // viem's EIP-1559 estimate: baseFee × 1.2 + priority tip
      expect(tx.maxPriorityFeePerGas).toBe(parseGwei("2"));
      expect(tx.maxFeePerGas).toBe((parseGwei("10") * 120n) / 100n + parseGwei("2"));
      expect(tx.gas).toBe(TRANSFER_GAS);
      expect(rpc.calls).toContain("eth_maxPriorityFeePerGas");

      const s = await sender.status();
      expect(s.maxFeePerGas).toBe(tx.maxFeePerGas);
      expect(payoutCost(parseEther("10"), s.maxFeePerGas)).toBe(parseEther("10") + TRANSFER_GAS * tx.maxFeePerGas);
    } finally {
      stop();
    }
  });
});

describe("viem sender: nonces", () => {
  it("hands out consecutive nonces to concurrent sends while the pending count stays flat", async () => {
    const rpc = new FakeRpc({ minedNonce: 41 });
    const sender = build(rpc);
    // No block during the broadcasts: eth_getTransactionCount(pending) is 41 throughout.
    const sends = Array.from({ length: 5 }, () => sender.send(DEV1, parseEther("1")));
    // Let all five reach the pool, then mine.
    await new Promise((r) => setTimeout(r, 50));
    expect(rpc.pool.map((t) => t.nonce).sort()).toEqual([41, 42, 43, 44, 45]);
    const stop = miner(rpc);
    try {
      const results = await Promise.all(sends);
      expect(results.every((r) => r.confirmed)).toBe(true);
      expect(new Set(results.map((r) => r.txHash)).size).toBe(5);
      expect(rpc.calls.filter((c) => c === "eth_getTransactionCount")).toHaveLength(1);
    } finally {
      stop();
    }
  });

  it("resyncs and retries inside the same request after a node-answered 'nonce too low'", async () => {
    const rpc = new FakeRpc({ minedNonce: 0 });
    const sender = build(rpc);
    const stop = miner(rpc);
    try {
      await sender.send(DEV1, 1n); // nonce 0, mined
      // Something else (an operator's manual tx) consumed nonces 1 and 2.
      rpc.minedNonce = 3;
      const sends = rpc.calls.filter((c) => c === "eth_sendRawTransaction").length;
      const r = await sender.send(DEV1, 1n);
      expect(r.confirmed).toBe(true);
      expect(rpc.mined.get(r.txHash)!.tx.nonce).toBe(3);
      expect(rpc.calls.filter((c) => c === "eth_sendRawTransaction").length - sends).toBe(2); // one rejected, one accepted
    } finally {
      stop();
    }
  });

  it("gives up after one retry with a pre-broadcast error (refundable)", async () => {
    const rpc = new FakeRpc();
    const sender = build(rpc);
    rpc.onSendRaw = () => rpc.rpcError("nonce too low");
    const err = await sender.send(DEV1, 1n).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SendError);
    expect((err as SendError).phase).toBe("pre-broadcast");
    expect(rpc.calls.filter((c) => c === "eth_sendRawTransaction")).toHaveLength(2);
  });

  it("two senders sharing one key alternate without a user-visible failure", async () => {
    const rpc = new FakeRpc();
    const a = build(rpc);
    const b = build(rpc);
    const stop = miner(rpc);
    try {
      for (let i = 0; i < 6; i++) {
        const r = await (i % 2 === 0 ? a : b).send(DEV1, 1n);
        expect(r.confirmed).toBe(true);
        expect(rpc.mined.get(r.txHash)!.tx.nonce).toBe(i);
      }
    } finally {
      stop();
    }
  });

  it("drops the counter after a receipt wait times out, so an evicted tx leaves no nonce gap", async () => {
    const rpc = new FakeRpc();
    const sender = build(rpc, { confirmTimeoutMs: 40 });
    const r = await sender.send(DEV1, 1n);
    expect(r.confirmed).toBe(false);
    // the node evicts it
    rpc.pool = [];
    const stop = miner(rpc);
    try {
      const r2 = await sender.send(DEV1, 1n);
      expect(r2.confirmed).toBe(true);
      expect(rpc.mined.get(r2.txHash)!.tx.nonce).toBe(0); // resynced, not 1
      expect(rpc.calls.filter((c) => c === "eth_getTransactionCount")).toHaveLength(2);
    } finally {
      stop();
    }
  });
});

describe("viem sender: broadcast failures", () => {
  it("a node rejection (insufficient funds) is pre-broadcast and does not advance the nonce", async () => {
    const rpc = new FakeRpc({ balance: parseEther("0.5") });
    const sender = build(rpc);
    const err = await sender.send(DEV1, parseEther("1")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SendError);
    expect((err as SendError).phase).toBe("pre-broadcast");
    expect((err as SendError).message).toMatch(/insufficient funds/);
    expect(rpc.pool).toHaveLength(0);

    rpc.balance = parseEther("100");
    const stop = miner(rpc);
    try {
      const r = await sender.send(DEV1, parseEther("1"));
      expect(rpc.mined.get(r.txHash)!.tx.nonce).toBe(0); // not 1
    } finally {
      stop();
    }
  });

  it("a timed-out broadcast whose tx the node accepted is NOT a failure: it is found once mined, confirmed, and the nonce moves on", async () => {
    const rpc = new FakeRpc();
    const sender = build(rpc);
    // The node takes the tx but the response is lost (HIGH-1 repro). The
    // hash lookup only answers after inclusion, so the poll window matters.
    rpc.onSendRaw = (_raw, tx) => {
      rpc.acceptTx(tx);
      rpc.timeout();
    };
    const stop = miner(rpc);
    try {
      const r = await sender.send(DEV1, parseEther("1"));
      expect(r.confirmed).toBe(true);
      expect(rpc.mined.get(r.txHash)!.tx.nonce).toBe(0);
      expect(rpc.calls).toContain("eth_getTransactionByHash");

      rpc.onSendRaw = null;
      const r2 = await sender.send(DEV1, parseEther("1"));
      expect(rpc.mined.get(r2.txHash)!.tx.nonce).toBe(1);
      expect(rpc.calls.filter((c) => c === "eth_sendRawTransaction")).toHaveLength(2); // no retry replay
    } finally {
      stop();
    }
  });

  it("a timed-out broadcast the node never saw is post-broadcast (ambiguous), never refunded", async () => {
    const rpc = new FakeRpc();
    const sender = build(rpc);
    rpc.onSendRaw = () => rpc.timeout();
    const err = await sender.send(DEV1, 1n).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SendError);
    expect((err as SendError).phase).toBe("post-broadcast");
    expect((err as SendError).txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect((err as SendError).message).not.toMatch(/http/);
    expect(rpc.calls.filter((c) => c === "eth_getTransactionByHash").length).toBeGreaterThan(2); // polled over the window
  });

  it("an immediate HTTP 502 from a proxy after the node took the tx is a success with a hash", async () => {
    const rpc = new FakeRpc();
    const sender = build(rpc);
    rpc.onSendRaw = (_raw, tx) => {
      rpc.acceptTx(tx);
      rpc.http502();
    };
    const stop = miner(rpc);
    try {
      const r = await sender.send(DEV1, 1n);
      expect(r.confirmed).toBe(true);
      expect(rpc.calls.filter((c) => c === "eth_sendRawTransaction")).toHaveLength(1);
    } finally {
      stop();
    }
  });

  it("'already known' with nothing to show for it is a stale counter: resync, retry, then refund", async () => {
    const rpc = new FakeRpc();
    const sender = build(rpc);
    rpc.onSendRaw = () => rpc.rpcError("already known");
    const err = await sender.send(DEV1, 1n).catch((e: unknown) => e);
    expect((err as SendError).phase).toBe("pre-broadcast");
    expect(rpc.calls.filter((c) => c === "eth_sendRawTransaction")).toHaveLength(2);
    expect(rpc.calls).toContain("eth_getTransactionByHash");
  });

  it("'already known' is believed when the lookup finds the tx", async () => {
    const rpc = new FakeRpc();
    const sender = build(rpc);
    rpc.onSendRaw = (_raw, tx) => {
      rpc.acceptTx(tx);
      rpc.mineBlock();
      rpc.rpcError("already known");
    };
    const r = await sender.send(DEV1, 1n);
    expect(r.confirmed).toBe(true);
    expect(rpc.calls.filter((c) => c === "eth_sendRawTransaction")).toHaveLength(1);
  });

  it("the ante handler's refusal is pre-broadcast and reaches the caller verbatim", async () => {
    const rpc = new FakeRpc();
    const sender = build(rpc);
    rpc.onSendRaw = () => rpc.rpcError('kons1… is not allowed to receive funds: it is the "fee_collector" module account');
    const err = await sender.send(DEV1, 1n).catch((e: unknown) => e);
    expect((err as SendError).phase).toBe("pre-broadcast");
    expect((err as SendError).message).toMatch(/fee_collector/);
  });
});

describe("viem sender: confirmation", () => {
  it("answers unconfirmed when no receipt arrives in time, and the tx stays in the pool", async () => {
    const rpc = new FakeRpc();
    const sender = build(rpc, { confirmTimeoutMs: 60 });
    const r = await sender.send(DEV1, 1n);
    expect(r.confirmed).toBe(false);
    expect(rpc.pool).toHaveLength(1);
  });

  it("a reverted receipt is a post-broadcast failure", async () => {
    const rpc = new FakeRpc();
    const sender = build(rpc);
    rpc.onSendRaw = (_raw, tx) => {
      rpc.revertHashes.add(tx.hash);
      return rpc.acceptTx(tx);
    };
    const stop = miner(rpc);
    try {
      const err = await sender.send(DEV1, 1n).catch((e: unknown) => e);
      expect((err as SendError).phase).toBe("post-broadcast");
      expect((err as SendError).message).toMatch(/reverted/);
    } finally {
      stop();
    }
  });
});
