// Optional CAPTCHA verification. Off by default (CAPTCHA_PROVIDER=off).
// When enabled, the page renders the provider's widget and POST /request
// must carry the widget's token as `captchaToken`; it is verified server
// side with the provider's siteverify endpoint before anything else runs.

import type { CaptchaProvider } from "./config.ts";

const VERIFY_URL: Record<Exclude<CaptchaProvider, "off">, string> = {
  hcaptcha: "https://api.hcaptcha.com/siteverify",
  turnstile: "https://challenges.cloudflare.com/turnstile/v0/siteverify",
};

export interface CaptchaVerifier {
  /** Resolves true if the token is valid for this site. Never throws on a bad token. */
  verify(token: string | undefined, remoteIp: string): Promise<boolean>;
}

export const noCaptcha: CaptchaVerifier = { verify: async () => true };

export function createCaptchaVerifier(
  provider: CaptchaProvider,
  secret: string | undefined,
  fetchImpl: typeof fetch = fetch,
): CaptchaVerifier {
  if (provider === "off") return noCaptcha;
  if (secret === undefined) throw new Error("captcha secret missing");
  const url = VERIFY_URL[provider];
  return {
    async verify(token, remoteIp) {
      if (typeof token !== "string" || token.length === 0 || token.length > 4096) return false;
      const body = new URLSearchParams({ secret, response: token, remoteip: remoteIp });
      try {
        const res = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body,
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) return false;
        const json = (await res.json()) as { success?: unknown };
        return json.success === true;
      } catch {
        return false;
      }
    },
  };
}
