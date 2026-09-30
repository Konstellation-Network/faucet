// The tiny static front end: one input, one button, the result. Served
// from memory so `tsc` has no assets to copy. The script lives at /app.js
// so the page can ship a CSP without 'unsafe-inline'.

import type { CaptchaProvider } from "./config.ts";

export interface PageOptions {
  networkName: string;
  chainId: number;
  amountKash: string;
  cooldownSeconds: number;
  bech32Prefix: string;
  captcha: { provider: CaptchaProvider; siteKey: string | undefined };
  explorerTxUrl: string | undefined;
}

const CAPTCHA_SCRIPT: Record<Exclude<CaptchaProvider, "off">, { src: string; className: string; origins: string[] }> = {
  hcaptcha: {
    src: "https://js.hcaptcha.com/1/api.js",
    className: "h-captcha",
    origins: ["https://js.hcaptcha.com", "https://*.hcaptcha.com"],
  },
  turnstile: {
    src: "https://challenges.cloudflare.com/turnstile/v0/api.js",
    className: "cf-turnstile",
    origins: ["https://challenges.cloudflare.com"],
  },
};

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function humanDuration(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400} day${seconds === 86_400 ? "" : "s"}`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600} hour${seconds === 3_600 ? "" : "s"}`;
  if (seconds % 60 === 0) return `${seconds / 60} minute${seconds === 60 ? "" : "s"}`;
  return `${seconds} seconds`;
}

/** Content-Security-Policy for the page, widened only for the enabled captcha provider. */
export function contentSecurityPolicy(provider: CaptchaProvider): string {
  const extra = provider === "off" ? [] : CAPTCHA_SCRIPT[provider].origins;
  const scriptSrc = ["'self'", ...extra].join(" ");
  const frameSrc = extra.length > 0 ? extra.join(" ") : "'none'";
  return [
    "default-src 'none'",
    `script-src ${scriptSrc}`,
    `frame-src ${frameSrc}`,
    `connect-src 'self' ${extra.join(" ")}`.trim(),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join("; ");
}

export function renderPage(o: PageOptions): string {
  const captcha = o.captcha.provider === "off" ? null : CAPTCHA_SCRIPT[o.captcha.provider];
  const captchaScript = captcha ? `<script src="${captcha.src}" async defer></script>` : "";
  const captchaWidget =
    captcha && o.captcha.siteKey
      ? `<div class="${captcha.className}" data-sitekey="${esc(o.captcha.siteKey)}"></div>`
      : "";
  const cfg = JSON.stringify({
    captchaProvider: o.captcha.provider,
    explorerTxUrl: o.explorerTxUrl ?? null,
    bech32Prefix: o.bech32Prefix,
  });

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Konstellation ${esc(o.networkName)} faucet</title>
<meta name="robots" content="noindex">
<style>
  :root { color-scheme: light dark; --fg: #1a1a1a; --bg: #fafafa; --muted: #666; --line: #d9d9d9; --accent: #2f5bea; --ok: #1a7f37; --err: #b42318; }
  @media (prefers-color-scheme: dark) { :root { --fg: #ececec; --bg: #121212; --muted: #9a9a9a; --line: #333; --accent: #7a9bff; --ok: #4ade80; --err: #f87171; } }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 16px; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 560px; margin: 8vh auto 0; }
  h1 { font-size: 1.4rem; margin: 0 0 4px; }
  p { margin: 0 0 16px; color: var(--muted); }
  form { display: grid; gap: 12px; }
  label { font-size: 0.9rem; }
  input { width: 100%; padding: 10px 12px; font: inherit; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--fg); background: transparent; border: 1px solid var(--line); border-radius: 6px; }
  input:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
  button { padding: 10px 16px; font: inherit; font-weight: 600; color: #fff; background: var(--accent); border: 0; border-radius: 6px; cursor: pointer; }
  button:disabled { opacity: .6; cursor: wait; }
  #result { margin-top: 16px; padding: 12px; border: 1px solid var(--line); border-radius: 6px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.85rem; word-break: break-all; display: none; }
  #result.ok { border-color: var(--ok); }
  #result.err { border-color: var(--err); color: var(--err); }
  footer { margin-top: 32px; font-size: 0.8rem; color: var(--muted); }
  a { color: var(--accent); }
</style>
${captchaScript}
</head>
<body>
<main>
  <h1>Konstellation ${esc(o.networkName)} faucet</h1>
  <p>Sends <strong>${esc(o.amountKash)} KASH</strong> of test tokens per request, once per address and per IP every ${humanDuration(o.cooldownSeconds)}. Chain id ${o.chainId}. Test tokens have no value.</p>
  <form id="f" autocomplete="off">
    <label for="address">Address (<code>0x…</code> or <code>${esc(o.bech32Prefix)}1…</code>)</label>
    <input id="address" name="address" placeholder="0x… or ${esc(o.bech32Prefix)}1…" required spellcheck="false" maxlength="90">
    ${captchaWidget}
    <button id="go" type="submit">Request ${esc(o.amountKash)} KASH</button>
  </form>
  <div id="result" role="status" aria-live="polite"></div>
  <footer>Devnet and testnet only — there is no faucet on konstellation-1 (mainnet). Status: <a href="/healthz">/healthz</a>.</footer>
</main>
<script id="cfg" type="application/json">${cfg.replace(/</g, "\\u003c")}</script>
<script src="/app.js"></script>
</body>
</html>
`;
}

export const APP_JS = `(() => {
  const cfg = JSON.parse(document.getElementById("cfg").textContent);
  const form = document.getElementById("f");
  const input = document.getElementById("address");
  const button = document.getElementById("go");
  const result = document.getElementById("result");

  function show(cls, html) { result.className = cls; result.innerHTML = html; result.style.display = "block"; }
  function esc(s) { return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }

  function captchaToken() {
    if (cfg.captchaProvider === "hcaptcha" && window.hcaptcha) return window.hcaptcha.getResponse();
    if (cfg.captchaProvider === "turnstile" && window.turnstile) return window.turnstile.getResponse();
    return undefined;
  }
  function captchaReset() {
    if (cfg.captchaProvider === "hcaptcha" && window.hcaptcha) window.hcaptcha.reset();
    if (cfg.captchaProvider === "turnstile" && window.turnstile) window.turnstile.reset();
  }

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    button.disabled = true;
    show("", "Sending…");
    try {
      const res = await fetch("/request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: input.value.trim(), captchaToken: captchaToken() }),
      });
      const body = await res.json().catch(() => ({ error: "bad response from faucet" }));
      if (res.ok) {
        const link = cfg.explorerTxUrl ? '<a href="' + esc(cfg.explorerTxUrl.replace("{hash}", body.txHash)) + '" target="_blank" rel="noopener">view in explorer</a>' : "";
        show("ok", "Sent " + esc(body.amountKash) + " KASH to " + esc(body.to) + "<br>(" + esc(body.toBech32) + ")<br>tx " + esc(body.txHash) + (link ? "<br>" + link : ""));
      } else {
        show("err", esc(body.error || ("error " + res.status)));
      }
    } catch (e) {
      show("err", "network error: " + esc(e && e.message ? e.message : e));
    } finally {
      button.disabled = false;
      captchaReset();
    }
  });
})();
`;
