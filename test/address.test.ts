import { describe, expect, it } from "vitest";
import { AddressError, bech32Decode, bech32Encode, parseAddress, toBech32 } from "../src/address.ts";

// dev0 from konstellation/local_node.sh (public dev key), bech32 form taken
// from `konstellationd keys show dev0 -a` on a local node. (The `cosmos1…`
// comment next to dev0 in local_node.sh is stale upstream text; the value
// below is the real encoding, cross-checked against the canonical
// fee_collector address in blocked.test.ts.)
const DEV0_HEX = "0xC6Fe5D33615a1C52c08018c47E8Bc53646A0E101";
const DEV0_KONS = "kons1cml96vmptgw99syqrrz8az79xer2pcgpvp4mvs";
const DEV0_COSMOS = "cosmos1cml96vmptgw99syqrrz8az79xer2pcgp95srxm";

// fee_collector module account, from `konstellationd debug addr`.
const FEE_COLLECTOR_HEX = "0xf1829676DB577682E944fc3493d451B67Ff3E29F";
const FEE_COLLECTOR_KONS = "kons17xpfvakm2amg962yls6f84z3kell8c5levxcpk";

describe("bech32", () => {
  it("decodes a kons1 address to 20 bytes", () => {
    const { prefix, bytes } = bech32Decode(DEV0_KONS);
    expect(prefix).toBe("kons");
    expect(Buffer.from(bytes).toString("hex")).toBe(DEV0_HEX.slice(2).toLowerCase());
  });

  it("round-trips through encode", () => {
    const bytes = Uint8Array.from(Buffer.from(DEV0_HEX.slice(2), "hex"));
    expect(bech32Encode("kons", bytes)).toBe(DEV0_KONS);
    expect(bech32Encode("cosmos", bytes)).toBe(DEV0_COSMOS);
    expect(toBech32(FEE_COLLECTOR_HEX)).toBe(FEE_COLLECTOR_KONS);
  });

  it("accepts BIP-173 reference vectors", () => {
    expect(bech32Decode("A12UEL5L").prefix).toBe("a");
    expect(bech32Decode("a12uel5l").prefix).toBe("a");
    expect(bech32Decode("abcdef1qpzry9x8gf2tvdw0s3jn54khce6mua7lmqqqxw").prefix).toBe("abcdef");
  });

  it("rejects a corrupted checksum", () => {
    const bad = DEV0_KONS.slice(0, -1) + (DEV0_KONS.endsWith("s") ? "t" : "s");
    expect(() => bech32Decode(bad)).toThrow(AddressError);
    expect(() => bech32Decode(bad)).toThrow(/checksum/);
  });

  it("rejects mixed case, bad characters and missing separators", () => {
    expect(() => bech32Decode("Kons1cml96vmptgw99syqrrz8az79xer2pcgpvp4mvs")).toThrow(/case/);
    expect(() => bech32Decode("kons1cml96vmptgw99syqrrz8az79xer2pcgpvp4mv1")).toThrow(AddressError);
    expect(() => bech32Decode("kons1cml96vmptgw99syqrrz8az79xer2pcgpvp4mvb")).toThrow(/invalid character/);
    expect(() => bech32Decode("konscml96vmptgw99syqrrz8az79xer2pcgpvp4mvs")).toThrow(/separator/);
  });
});

describe("parseAddress", () => {
  it("returns a checksummed 0x address for a 0x input", () => {
    expect(parseAddress(DEV0_HEX)).toBe(DEV0_HEX);
    expect(parseAddress(DEV0_HEX.toLowerCase())).toBe(DEV0_HEX);
    expect(parseAddress(`0x${DEV0_HEX.slice(2).toUpperCase()}`)).toBe(DEV0_HEX);
    expect(parseAddress(`  ${DEV0_HEX}\n`)).toBe(DEV0_HEX);
  });

  it("rejects a 0x address with a wrong EIP-55 checksum", () => {
    // flip the case of one letter
    const wrong = `0xc6Fe5D33615a1C52c08018c47E8Bc53646A0E101`;
    expect(() => parseAddress(wrong)).toThrow(/checksum/);
  });

  it("converts a kons1 address to the same 0x address", () => {
    expect(parseAddress(DEV0_KONS)).toBe(DEV0_HEX);
    expect(parseAddress(DEV0_KONS.toUpperCase())).toBe(DEV0_HEX);
    expect(parseAddress(FEE_COLLECTOR_KONS)).toBe(FEE_COLLECTOR_HEX);
  });

  it("rejects other bech32 prefixes", () => {
    expect(() => parseAddress(DEV0_COSMOS)).toThrow(/must be 0x… or kons1…/);
    expect(() => parseAddress(DEV0_COSMOS, "cosmos")).not.toThrow();
    expect(() => parseAddress("konsvaloper17xpfvakm2amg962yls6f84z3kell8c5l76kwc3")).toThrow(AddressError);
  });

  it("rejects wrong payload sizes", () => {
    // 32-byte payload under the kons prefix
    const b32 = bech32Encode("kons", new Uint8Array(32));
    expect(() => parseAddress(b32)).toThrow(/20 bytes/);
  });

  it("rejects garbage", () => {
    for (const bad of ["", "   ", "0x", "0x123", "0xZZ", 42, null, undefined, {}, "hello", `0x${"0".repeat(39)}`]) {
      expect(() => parseAddress(bad)).toThrow(AddressError);
    }
  });
});
