import { describe, expect, it } from "vitest";
import { canonicalIp, forwardedClientIp, ipInCidrs, parseCidr } from "../src/ip.ts";

describe("canonicalIp", () => {
  it("keys IPv4 by the address", () => {
    expect(canonicalIp("198.51.100.1")).toMatchObject({ address: "198.51.100.1", key: "198.51.100.1", family: 4 });
    expect([...canonicalIp("198.51.100.1")!.bytes]).toEqual([198, 51, 100, 1]);
    expect(canonicalIp(" 198.51.100.001 ")).toBeNull(); // leading zeros are not an IP to node's net.isIP
  });

  it("unmaps IPv4-mapped IPv6 in both notations to the IPv4 key", () => {
    for (const v of ["::ffff:198.51.100.1", "::FFFF:198.51.100.1", "::ffff:c633:6401", "::FFFF:c633:6401", "[::ffff:198.51.100.1]"]) {
      expect(canonicalIp(v)?.key).toBe("198.51.100.1");
    }
  });

  it("keys IPv6 by the /64, canonicalising case and zero compression", () => {
    const forms = ["2001:db8::1", "2001:DB8::1", "2001:db8:0:0:0:0:0:1", "2001:0db8:0000:0000:0000:0000:0000:0001", "[2001:db8::1]", "2001:db8::1%eth0"];
    for (const f of forms) {
      const c = canonicalIp(f);
      expect(c).toMatchObject({ address: "2001:db8:0:0:0:0:0:1", key: "2001:db8:0:0::/64", family: 6 });
      expect(c!.bytes).toHaveLength(16);
    }
    // a different host in the same /64 shares the key
    expect(canonicalIp("2001:db8::2")?.key).toBe("2001:db8:0:0::/64");
    expect(canonicalIp("2001:db8::ffff:ffff:ffff:ffff")?.key).toBe("2001:db8:0:0::/64");
    // a different /64 does not
    expect(canonicalIp("2001:db8:0:1::1")?.key).toBe("2001:db8:0:1::/64");
  });

  it("rejects non-addresses", () => {
    for (const bad of ["", "not-an-ip-6418", "198.51.100", "198.51.100.256", "2001:db8:::1", "2001:db8::1::2", "unknown", "::ffff:300.1.1.1", "x".repeat(70)]) {
      expect(canonicalIp(bad)).toBeNull();
    }
  });
});

describe("forwardedClientIp", () => {
  it("takes the rightmost entry with one trusted hop", () => {
    expect(forwardedClientIp("198.51.100.1, 10.0.0.9", 1)?.address).toBe("10.0.0.9");
    expect(forwardedClientIp("attacker-controlled, 10.0.0.9", 1)?.address).toBe("10.0.0.9");
  });

  it("counts hops from the right", () => {
    expect(forwardedClientIp("203.0.113.5, 10.0.0.9, 10.0.0.8", 2)?.address).toBe("10.0.0.9");
    expect(forwardedClientIp("203.0.113.5, 10.0.0.9, 10.0.0.8", 3)?.address).toBe("203.0.113.5");
    expect(forwardedClientIp("10.0.0.8", 2)).toBeNull(); // fewer entries than hops
  });

  it("joins repeated headers and rejects a non-IP in the trusted slot", () => {
    expect(forwardedClientIp(["1.1.1.1", "2.2.2.2"], 1)?.address).toBe("2.2.2.2");
    expect(forwardedClientIp("1.1.1.1, not-an-ip-6418", 1)).toBeNull();
    expect(forwardedClientIp(undefined, 1)).toBeNull();
    expect(forwardedClientIp("", 1)).toBeNull();
  });
});

describe("CIDRs", () => {
  it("parses v4/v6 CIDRs and bare addresses", () => {
    expect(parseCidr("10.0.0.0/8")).toMatchObject({ family: 4, prefix: 8, text: "10.0.0.0/8" });
    expect(parseCidr("192.0.2.7")).toMatchObject({ family: 4, prefix: 32 });
    expect(parseCidr("2001:db8::/32")).toMatchObject({ family: 6, prefix: 32 });
    expect(parseCidr("::1")).toMatchObject({ family: 6, prefix: 128 });
    expect(parseCidr("::ffff:10.0.0.0/8")).toMatchObject({ family: 4, prefix: 8 }); // v4-mapped → v4
    for (const bad of ["10.0.0.0/33", "2001:db8::/129", "10.0.0/8", "10.0.0.0/x", "", "proxy"]) expect(parseCidr(bad)).toBeNull();
  });

  it("matches by prefix bits and never across families", () => {
    const cidrs = [parseCidr("172.16.0.0/12")!, parseCidr("2001:db8::/32")!, parseCidr("192.0.2.7")!];
    const ip = (s: string) => canonicalIp(s)!;
    expect(ipInCidrs(ip("172.16.0.1"), cidrs)).toBe(true);
    expect(ipInCidrs(ip("172.31.255.255"), cidrs)).toBe(true);
    expect(ipInCidrs(ip("172.32.0.0"), cidrs)).toBe(false);
    expect(ipInCidrs(ip("192.0.2.7"), cidrs)).toBe(true);
    expect(ipInCidrs(ip("192.0.2.8"), cidrs)).toBe(false);
    expect(ipInCidrs(ip("2001:db8:ffff::1"), cidrs)).toBe(true);
    expect(ipInCidrs(ip("2001:db9::1"), cidrs)).toBe(false);
    expect(ipInCidrs(ip("::ffff:172.16.0.1"), cidrs)).toBe(true); // arrives v4-mapped on a dual-stack socket
    expect(ipInCidrs(ip("10.0.0.1"), [])).toBe(false);
    expect(ipInCidrs(ip("0.0.0.0"), [parseCidr("0.0.0.0/0")!])).toBe(true);
  });
});
