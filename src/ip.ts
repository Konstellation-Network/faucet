// Client IP handling: which X-Forwarded-For hop to believe, and how to turn
// an address into a rate-limit key that the client cannot vary.
//
// Two things the first version got wrong (PR #1 review):
//  - it took the *leftmost* X-Forwarded-For entry, which is whatever the
//    client sent; proxies append the peer address on the right, so only the
//    rightmost `hops` entries are trustworthy;
//  - it keyed IPv6 per address and never canonicalised, so `2001:db8::1`,
//    `2001:DB8::1` and `2001:db8:0:0:0:0:0:1` were three keys, and
//    `::ffff:c633:6401` slipped past the cooldown on `198.51.100.1`.

import { isIP } from "node:net";

export interface CanonicalIp {
  /** Canonical textual form: dotted IPv4, or lowercase expanded IPv6 (no zone). */
  address: string;
  /** Rate-limit key: the IPv4 address, or the IPv6 /64 as `a:b:c:d::/64`. */
  key: string;
  family: 4 | 6;
}

function parseIPv4(s: string): number[] | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

/** Expands an IPv6 string to eight 16-bit groups, or null if it is not one. */
function parseIPv6(s: string): number[] | null {
  let str = s;
  // Embedded IPv4 in the last 32 bits (::ffff:1.2.3.4).
  const lastColon = str.lastIndexOf(":");
  if (lastColon !== -1 && str.slice(lastColon + 1).includes(".")) {
    const v4 = parseIPv4(str.slice(lastColon + 1));
    if (!v4) return null;
    str = `${str.slice(0, lastColon + 1)}${((v4[0]! << 8) | v4[1]!).toString(16)}:${((v4[2]! << 8) | v4[3]!).toString(16)}`;
  }
  const halves = str.split("::");
  if (halves.length > 2) return null;
  const parseGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const g of part.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = parseGroups(halves[0]!);
  const tail = halves.length === 2 ? parseGroups(halves[1]!) : [];
  if (!head || !tail) return null;
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 1) return null;
    return [...head, ...new Array<number>(fill).fill(0), ...tail];
  }
  return head.length === 8 ? head : null;
}

/**
 * Canonicalises a client address. Accepts what `socket.remoteAddress` and
 * X-Forwarded-For produce: optional `[...]` brackets, an optional `%zone`,
 * IPv4-mapped IPv6 in either notation. Returns null for anything that is
 * not an IP address.
 */
export function canonicalIp(raw: string): CanonicalIp | null {
  let s = raw.trim();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  const zone = s.indexOf("%");
  if (zone !== -1) s = s.slice(0, zone);
  if (s.length === 0 || s.length > 64) return null;

  const kind = isIP(s);
  if (kind === 4) {
    const v4 = parseIPv4(s);
    if (!v4) return null;
    const address = v4.join(".");
    return { address, key: address, family: 4 };
  }
  if (kind !== 6) return null;

  const groups = parseIPv6(s);
  if (!groups) return null;
  // IPv4-mapped (::ffff:a.b.c.d) → the IPv4 address.
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    const a = groups[6]!;
    const b = groups[7]!;
    const address = `${a >> 8}.${a & 0xff}.${b >> 8}.${b & 0xff}`;
    return { address, key: address, family: 4 };
  }
  const hex = groups.map((g) => g.toString(16));
  return {
    address: hex.join(":"),
    key: `${hex.slice(0, 4).join(":")}::/64`,
    family: 6,
  };
}

/**
 * Picks the client address from X-Forwarded-For. Proxies append the peer on
 * the right, so with `hops` trusted proxies in front the client is the
 * `hops`-th entry from the right; everything left of it is client-supplied.
 * Returns null when the header is missing or that entry is not an IP.
 */
export function forwardedClientIp(xff: string | string[] | undefined, hops: number): CanonicalIp | null {
  if (xff === undefined) return null;
  const entries = (Array.isArray(xff) ? xff.join(",") : xff)
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const idx = entries.length - hops;
  if (idx < 0) return null;
  return canonicalIp(entries[idx]!);
}
