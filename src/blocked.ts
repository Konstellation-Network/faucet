// Addresses the faucet refuses to send to.
//
// The chain refuses a value transfer to any of these at submission
// (`konstellation/app/blocked_recipient.go`, STATUS.md §3): module accounts
// and precompiles can never hold funds, and before that check existed such a
// tx was charged gas and then vanished from `eth_*`. The faucet pre-checks
// the same set so a bad request gets a clear 400 without touching the RPC,
// and so a misconfigured chain can never make the faucet burn its balance
// into an account nobody can spend from.
//
// THIS LIST IS A COPY. The source of truth is
// `konstellation/app/config/permissions.go` (`BlockedAddresses`,
// `maccPerms`). When a module account or precompile is added there, add it
// here. `test/blocked.test.ts` re-derives every module address from its name
// (sha256(name)[:20], the SDK's `NewModuleAddress`) so a typo here fails CI,
// but it cannot know about a module that was never listed.

import { createHash } from "node:crypto";
import { getAddress } from "viem";
import type { HexAddress } from "./address.ts";

export const ZERO_ADDRESS: HexAddress = "0x0000000000000000000000000000000000000000";

/** Module account names from `konstellation/app/config/permissions.go` `maccPerms`. */
export const MODULE_ACCOUNT_NAMES = [
  "fee_collector", // x/auth
  "distribution",
  "transfer", // ibc-go transfer
  "mint",
  "bonded_tokens_pool", // x/staking
  "not_bonded_tokens_pool", // x/staking
  "gov",
  "evm", // cosmos/evm x/vm
  "feemarket",
  "erc20",
] as const;

/** `authtypes.NewModuleAddress(name)`: the first 20 bytes of sha256(name). */
export function moduleAddress(name: string): HexAddress {
  const digest = createHash("sha256").update(name).digest("hex").slice(0, 40);
  return getAddress(`0x${digest}`);
}

/**
 * Precompile addresses, hex. From `BlockedAddresses()`:
 *  - cosmos/evm `x/vm/types.AvailableStaticPrecompiles` (v0.7.3)
 *  - the D6 compliance precompile (`app/config/chain.go`)
 *  - go-ethereum `PrecompiledAddressesPrague` (0x01 … 0x11)
 */
export const PRECOMPILE_ADDRESSES: readonly HexAddress[] = [
  "0x0000000000000000000000000000000000000100", // p256
  "0x0000000000000000000000000000000000000400", // bech32
  "0x0000000000000000000000000000000000000800", // staking
  "0x0000000000000000000000000000000000000801", // distribution
  "0x0000000000000000000000000000000000000802", // ics20
  "0x0000000000000000000000000000000000000803", // vesting
  "0x0000000000000000000000000000000000000804", // bank
  "0x0000000000000000000000000000000000000805", // gov
  "0x0000000000000000000000000000000000000806", // slashing
  "0x0000000000000000000000000000000000000807", // ics02
  "0x0000000000000000000000000000000000000900", // compliance (D6)
  ...Array.from({ length: 0x11 }, (_, i) => {
    const n = (i + 1).toString(16).padStart(40, "0");
    return getAddress(`0x${n}`);
  }),
];

const blocked: ReadonlyMap<string, string> = (() => {
  const m = new Map<string, string>();
  m.set(ZERO_ADDRESS.toLowerCase(), "the zero address");
  for (const name of MODULE_ACCOUNT_NAMES) {
    m.set(moduleAddress(name).toLowerCase(), `the "${name}" module account`);
  }
  for (const a of PRECOMPILE_ADDRESSES) {
    m.set(a.toLowerCase(), "a precompile");
  }
  return m;
})();

/** Returns why `address` may not receive funds, or null if it may. */
export function blockedReason(address: HexAddress): string | null {
  return blocked.get(address.toLowerCase()) ?? null;
}

export function isBlocked(address: HexAddress): boolean {
  return blockedReason(address) !== null;
}
