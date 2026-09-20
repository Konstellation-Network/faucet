import { describe, expect, it } from "vitest";
import { parseAddress, toBech32 } from "../src/address.js";
import { blockedReason, isBlocked, MODULE_ACCOUNT_NAMES, moduleAddress, PRECOMPILE_ADDRESSES, ZERO_ADDRESS } from "../src/blocked.js";

describe("blocked recipients", () => {
  it("derives module addresses the way the SDK does", () => {
    // fee_collector is the well-known one: cosmos17xpfvakm2amg962yls6f84z3kell8c5lserqta
    expect(moduleAddress("fee_collector")).toBe("0xf1829676DB577682E944fc3493d451B67Ff3E29F");
    expect(toBech32(moduleAddress("fee_collector"), "cosmos")).toBe("cosmos17xpfvakm2amg962yls6f84z3kell8c5lserqta");
    // and the kons1 form printed by `konstellationd debug addr` on the dev chain
    expect(parseAddress("kons17xpfvakm2amg962yls6f84z3kell8c5levxcpk")).toBe(moduleAddress("fee_collector"));
  });

  it("blocks every module account, in both address forms", () => {
    expect(MODULE_ACCOUNT_NAMES).toHaveLength(10);
    for (const name of MODULE_ACCOUNT_NAMES) {
      const hex = moduleAddress(name);
      expect(blockedReason(hex)).toBe(`the "${name}" module account`);
      expect(blockedReason(hex.toLowerCase() as `0x${string}`)).not.toBeNull();
    }
  });

  it("blocks the zero address and every precompile", () => {
    expect(blockedReason(ZERO_ADDRESS)).toBe("the zero address");
    // 10 cosmos/evm static precompiles + compliance + 17 Ethereum (0x01..0x11)
    expect(PRECOMPILE_ADDRESSES).toHaveLength(10 + 1 + 17);
    for (const a of PRECOMPILE_ADDRESSES) expect(isBlocked(a)).toBe(true);
    expect(isBlocked("0x0000000000000000000000000000000000000900")).toBe(true);
    expect(isBlocked("0x0000000000000000000000000000000000000001")).toBe(true);
    expect(isBlocked("0x0000000000000000000000000000000000000011")).toBe(true);
  });

  it("does not block ordinary accounts or preinstalls", () => {
    expect(isBlocked("0xC6Fe5D33615a1C52c08018c47E8Bc53646A0E101")).toBe(false); // dev0
    expect(isBlocked("0xcA11bde05977b3631167028862bE2a173976CA11")).toBe(false); // Multicall3
    expect(isBlocked("0x0000000000000000000000000000000000000012")).toBe(false); // one past the last precompile
    expect(isBlocked("0x0000000000000000000000000000000000000808")).toBe(false); // one past ics02
  });
});
