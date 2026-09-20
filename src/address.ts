// Address parsing: accepts a 0x EVM address or a bech32 `kons1…` account
// address and normalises both to an EIP-55 checksummed 0x address.
//
// On cosmos/evm the two forms are the same 20 bytes: a bech32 account
// address is the raw address bytes in a different encoding, so
// `kons1cml96…` and `0xC6Fe5D…` are one account. Converting here means the
// rest of the faucet (blocked list, rate limiter, the send itself) only ever
// sees one form.
//
// The bech32 decoder is written out here rather than pulled in as a
// dependency: it is ~60 lines of a fixed spec (BIP-173, classic bech32 —
// Cosmos does not use bech32m), and every dependency of a service that
// holds a funded key is supply-chain surface.

import { getAddress } from "viem";

export const DEFAULT_BECH32_PREFIX = "kons";

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
const BECH32_CONST = 1;

export class AddressError extends Error {
  override readonly name = "AddressError";
}

function polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((top >>> i) & 1) chk ^= GENERATOR[i]!;
    }
  }
  return chk >>> 0;
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >>> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}

/** Converts 5-bit groups to 8-bit bytes, rejecting non-zero padding. */
function convertBits5to8(data: number[]): Uint8Array {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  for (const v of data) {
    acc = (acc << 5) | v;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      out.push((acc >>> bits) & 0xff);
    }
  }
  if (bits >= 5 || ((acc << (8 - bits)) & 0xff) !== 0) {
    throw new AddressError("invalid bech32 padding");
  }
  return Uint8Array.from(out);
}

/** Converts 8-bit bytes to 5-bit groups with zero padding (encoding side). */
function convertBits8to5(data: Uint8Array): number[] {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  for (const b of data) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out.push((acc >>> bits) & 31);
    }
  }
  if (bits > 0) out.push((acc << (5 - bits)) & 31);
  return out;
}

export interface Bech32Decoded {
  prefix: string;
  bytes: Uint8Array;
}

/** Decodes a classic (BIP-173) bech32 string. Throws AddressError on any defect. */
export function bech32Decode(input: string): Bech32Decoded {
  if (input.length < 8 || input.length > 90) {
    throw new AddressError("bech32 string has an invalid length");
  }
  const hasLower = input !== input.toUpperCase();
  const hasUpper = input !== input.toLowerCase();
  if (hasLower && hasUpper) throw new AddressError("bech32 string mixes upper and lower case");
  const s = input.toLowerCase();
  const sep = s.lastIndexOf("1");
  if (sep < 1 || sep + 7 > s.length) throw new AddressError("bech32 string has no valid separator");
  const prefix = s.slice(0, sep);
  for (const c of prefix) {
    const code = c.charCodeAt(0);
    if (code < 33 || code > 126) throw new AddressError("bech32 prefix has invalid characters");
  }
  const data: number[] = [];
  for (const c of s.slice(sep + 1)) {
    const v = CHARSET.indexOf(c);
    if (v === -1) throw new AddressError(`bech32 data has an invalid character "${c}"`);
    data.push(v);
  }
  if (polymod([...hrpExpand(prefix), ...data]) !== BECH32_CONST) {
    throw new AddressError("bech32 checksum mismatch");
  }
  return { prefix, bytes: convertBits5to8(data.slice(0, -6)) };
}

/** Encodes bytes as classic bech32 with the given prefix. Used by tests and the UI. */
export function bech32Encode(prefix: string, bytes: Uint8Array): string {
  const data = convertBits8to5(bytes);
  const values = [...hrpExpand(prefix), ...data, 0, 0, 0, 0, 0, 0];
  const mod = polymod(values) ^ BECH32_CONST;
  const checksum: number[] = [];
  for (let i = 0; i < 6; i++) checksum.push((mod >>> (5 * (5 - i))) & 31);
  return `${prefix}1${[...data, ...checksum].map((v) => CHARSET[v]).join("")}`;
}

export type HexAddress = `0x${string}`;

/**
 * Parses a user-supplied address into a checksummed 0x address.
 *
 * Accepts:
 *  - `0x` + 40 hex chars (any case; a mixed-case input must have a valid
 *    EIP-55 checksum, all-lower/all-upper is accepted as unchecksummed)
 *  - bech32 `<prefix>1…` with a 20-byte payload
 */
export function parseAddress(raw: unknown, bech32Prefix = DEFAULT_BECH32_PREFIX): HexAddress {
  if (typeof raw !== "string") throw new AddressError("address must be a string");
  const input = raw.trim();
  if (input.length === 0) throw new AddressError("address is empty");

  if (input.startsWith("0x") || input.startsWith("0X")) {
    const hex = `0x${input.slice(2)}`;
    if (!/^0x[0-9a-fA-F]{40}$/.test(hex)) {
      throw new AddressError("0x address must be 40 hex characters");
    }
    const body = hex.slice(2);
    const checksummed = getAddress(hex);
    // All-lower or all-upper carries no checksum; anything mixed must be a valid EIP-55 one.
    const unchecksummed = body === body.toLowerCase() || body === body.toUpperCase();
    if (!unchecksummed && checksummed !== hex) {
      throw new AddressError("0x address has an invalid EIP-55 checksum");
    }
    return checksummed;
  }

  if (input.toLowerCase().startsWith(`${bech32Prefix}1`)) {
    const { prefix, bytes } = bech32Decode(input);
    if (prefix !== bech32Prefix) {
      throw new AddressError(`bech32 prefix must be "${bech32Prefix}", got "${prefix}"`);
    }
    if (bytes.length !== 20) {
      throw new AddressError(`bech32 address must carry 20 bytes, got ${bytes.length}`);
    }
    return getAddress(`0x${Buffer.from(bytes).toString("hex")}`);
  }

  throw new AddressError(`address must be 0x… or ${bech32Prefix}1…`);
}

/** Bech32 form of a 0x address, for display. */
export function toBech32(hex: HexAddress, bech32Prefix = DEFAULT_BECH32_PREFIX): string {
  return bech32Encode(bech32Prefix, Uint8Array.from(Buffer.from(hex.slice(2), "hex")));
}
