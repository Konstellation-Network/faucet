#!/usr/bin/env node
// Fails if any commit reachable from HEAD contains key material.
//
//  - every 32-byte hex string, in any file, in any commit — unless it is
//    exactly an allow-listed public value (the dev0 key from
//    konstellation/local_node.sh), an obvious placeholder (four or fewer
//    distinct hex digits, e.g. 0xabc000…), or a `sha256:…` image digest on
//    a Dockerfile `FROM` line (the base-image pin) — nowhere else;
//  - any run of 12+ consecutive BIP-39 English words (a mnemonic), in any
//    text file, in any commit.
//
// Tokens are extracted with -o and compared whole, so a placeholder on the
// same line can no longer hide a real key (PR #1 review LOW-2).

import { execFileSync } from "node:child_process";
import { english } from "viem/accounts";

const ALLOWED_HEX = new Set([
  // dev0 from konstellation/local_node.sh — public, funds a local dev chain only
  "88cbead91aee890d27bf06e003ade3d4e952427e88f88d31d61d3ef5e5d54305",
]);
const SKIP_PATHS = new Set(["package-lock.json"]);
const MNEMONIC_MIN_WORDS = 12;

const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

const commits = git("rev-list", "HEAD").trim().split("\n").filter(Boolean);
const words = new Set(english);
const findings = [];
const seenBlobs = new Set();

for (const commit of commits) {
  const entries = git("ls-tree", "-r", "-z", commit).split("\0").filter(Boolean);
  for (const entry of entries) {
    const [meta, path] = entry.split("\t");
    const [, type, blob] = meta.split(/\s+/);
    if (type !== "blob" || SKIP_PATHS.has(path) || seenBlobs.has(blob)) continue;
    seenBlobs.add(blob);
    const buf = execFileSync("git", ["cat-file", "blob", blob], { maxBuffer: 64 * 1024 * 1024 });
    if (buf.includes(0)) continue; // binary
    const text = buf.toString("utf8");
    const where = `${commit.slice(0, 8)}:${path}`;

    const isDockerfile = /(^|\/)Dockerfile(\.[\w.-]+)?$/.test(path);
    const seenHere = new Set();
    for (const m of text.matchAll(/(?<![0-9a-fA-F])(sha256:|0x)?([0-9a-fA-F]{64})(?![0-9a-fA-F])/g)) {
      const hex = m[2].toLowerCase();
      if (ALLOWED_HEX.has(hex) || seenHere.has(hex)) continue;
      if (m[1] === "sha256:" && isDockerfile) {
        const lineStart = text.lastIndexOf("\n", m.index) + 1;
        if (/^\s*FROM\s/i.test(text.slice(lineStart, m.index))) continue;
      }
      if (new Set(hex).size <= 4) continue; // placeholder
      seenHere.add(hex);
      findings.push(`${where}: 32-byte hex string ${hex.slice(0, 8)}…${hex.slice(-6)}`);
    }

    const tokens = text.toLowerCase().split(/[^a-z]+/);
    let run = 0;
    for (let i = 0; i <= tokens.length; i++) {
      if (i < tokens.length && words.has(tokens[i])) {
        run++;
        continue;
      }
      if (run >= MNEMONIC_MIN_WORDS) {
        findings.push(`${where}: ${run} consecutive BIP-39 words: "${tokens.slice(i - run, i - run + 4).join(" ")} …"`);
      }
      run = 0;
    }
  }
}

if (findings.length > 0) {
  console.error("possible key material:");
  for (const f of findings) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`secret scan: ${commits.length} commit(s), ${seenBlobs.size} blob(s), clean`);
