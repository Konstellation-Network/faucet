// The one place that talks to the chain. Everything above it depends on the
// `Sender` interface so it can be mocked in tests.

import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Chain,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { HexAddress } from "./address.js";

export interface ChainStatus {
  chainId: number;
  blockNumber: bigint;
  faucetBalanceWei: bigint;
}

export interface Sender {
  readonly address: HexAddress;
  /** Sends `valueWei` to `to` as an EIP-1559 transaction and returns the tx hash. */
  send(to: HexAddress, valueWei: bigint): Promise<Hex>;
  status(): Promise<ChainStatus>;
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
}

export function createViemSender(opts: ViemSenderOptions): Sender {
  const chain = konstellationChain(opts.chainId, opts.rpcUrl, opts.networkName);
  const transport = http(opts.rpcUrl, { timeout: opts.timeoutMs ?? 15_000, retryCount: 1 });
  const account = privateKeyToAccount(opts.privateKey);
  const publicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({ account, chain, transport });

  // Sends are serialised: the nonce is fetched from the `pending` pool at
  // send time, so two in-flight sends must not race for the same nonce.
  let queue: Promise<unknown> = Promise.resolve();

  return {
    address: account.address,

    send(to, valueWei) {
      const run = async (): Promise<Hex> => {
        const nonce = await publicClient.getTransactionCount({ address: account.address, blockTag: "pending" });
        return walletClient.sendTransaction({
          to,
          value: valueWei,
          type: "eip1559",
          nonce,
          // A plain transfer to an EOA is 21 000 gas; to a contract it may
          // be more, so let the node estimate rather than hard-coding.
        });
      };
      const p = queue.then(run, run);
      queue = p.catch(() => undefined);
      return p;
    },

    async status() {
      const [chainId, blockNumber, faucetBalanceWei] = await Promise.all([
        publicClient.getChainId(),
        publicClient.getBlockNumber(),
        publicClient.getBalance({ address: account.address }),
      ]);
      return { chainId, blockNumber, faucetBalanceWei };
    },
  };
}
