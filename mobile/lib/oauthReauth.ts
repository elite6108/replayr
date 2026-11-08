import * as Linking from "expo-linking";
import * as WebBrowser from "expo-web-browser";
import { getSupabase } from "./supabase";

const OAUTH_PROVIDERS = ["google", "apple", "discord", "twitter"] as const;
const OAUTH_AMR_METHODS = new Set(["oauth", "google", "apple", "discord", "twitter", "x"]);
const OAUTH_REAUTH_MS = 10 * 60 * 1000;

export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

WebBrowser.maybeCompleteAuthSession();

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

/** Opens the provider, then returns the new access token. Closing the window deletes nothing. */
export async function signInWithProviderAgain(provider: OAuthProvider): Promise<string> {
  const redirectTo = Linking.createURL("auth/callback");
  const { data, error } = await getSupabase().auth.signInWithOAuth({
    provider,
    options: { redirectTo, skipBrowserRedirect: true, queryParams: { prompt: "login" } },
  });
  if (error) throw error;
  if (!data.url) throw new Error("Could not start social sign-in.");
  const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
  if (result.type !== "success") {
    throw new Error("Sign in with your provider again, then delete the account.");
  }
  const params = authParams(result.url);
  if (params.error) throw new Error(params.error);
  if (!params.code) throw new Error("Could not finish social sign-in.");
  const exchanged = await getSupabase().auth.exchangeCodeForSession(params.code);
  if (exchanged.error) throw exchanged.error;
  const session = await getSupabase().auth.getSession();
  const token = session.data.session?.access_token;
  if (!token) throw new Error("Sign in with your provider again, then delete the account.");
  return token;
}

function authParams(url: string): { code: string | null; error: string | null } {
  const normalized = url.replace("#", "?");
  try {
    const parsed = new URL(normalized);
    return {
      code: parsed.searchParams.get("code"),
      error: parsed.searchParams.get("error_description") || parsed.searchParams.get("error"),
    };
  } catch {
    const code = /[?&]code=([^&]+)/.exec(normalized)?.[1] ?? null;
    const error =
      /[?&]error_description=([^&]+)/.exec(normalized)?.[1] ?? /[?&]error=([^&]+)/.exec(normalized)?.[1] ?? null;
    return { code: code ? decodeURIComponent(code) : null, error: error ? decodeURIComponent(error) : null };
  }
}
