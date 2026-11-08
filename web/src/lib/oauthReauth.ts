const OAUTH_PROVIDERS = ["google", "apple", "discord", "twitter"] as const;
const OAUTH_AMR_METHODS = new Set(["oauth", "google", "apple", "discord", "twitter", "x"]);
const OAUTH_REAUTH_MS = 10 * 60 * 1000;

export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

export function oauthProvider(
  identities: Array<{ provider?: string }> | null | undefined,
): OAuthProvider | null {
  for (const identity of identities ?? []) {
    const provider = identity.provider;
    if (provider && (OAUTH_PROVIDERS as readonly string[]).includes(provider)) return provider as OAuthProvider;
  }
  return null;
}

/** Matches the worker check. The server still rejects a stale provider sign-in. */
export function oauthReauthIsFresh(token: string, nowMs = Date.now()): boolean {
  const part = token.split(".")[1];
  if (!part) return false;
  try {
    const padded = part.replace(/-/g, "+").replace(/_/g, "/");
    const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
    const payload = JSON.parse(atob(padded + pad)) as { amr?: Array<{ method?: string; timestamp?: number }> };
    if (!Array.isArray(payload.amr)) return false;
    for (const entry of payload.amr) {
      const method = String(entry?.method ?? "").toLowerCase();
      const timestamp = Number(entry?.timestamp);
      if (!OAUTH_AMR_METHODS.has(method) || !Number.isFinite(timestamp)) continue;
      const at = timestamp > 10_000_000_000 ? timestamp : timestamp * 1000;
      if (at <= nowMs + 5_000 && nowMs - at <= OAUTH_REAUTH_MS) return true;
    }
    return false;
  } catch {
    return false;
  }
}
