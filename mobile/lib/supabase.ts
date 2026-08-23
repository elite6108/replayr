import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { sessionStorage } from "./sessionStorage";

let client: SupabaseClient | null = null;

export function supabaseConfigured(): boolean {
  return Boolean(process.env.EXPO_PUBLIC_SUPABASE_URL && process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY);
}

export function getSupabase(): SupabaseClient {
  if (client) return client;
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) throw new Error("Supabase is not configured.");
  client = createClient(url, anonKey, {
    auth: {
      storage: sessionStorage,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      flowType: "pkce",
    },
  });
  return client;
}

export function publicAppUrl(): string {
  const fromEnv = (process.env.EXPO_PUBLIC_APP_URL || "https://www.replayr.tv").replace(/\/$/, "");
  try {
    const parsed = new URL(fromEnv);
    if (parsed.hostname === "replayr.tv") parsed.hostname = "www.replayr.tv";
    return parsed.origin;
  } catch {
    return fromEnv;
  }
}

export function publicShareUrl(): string {
  return "https://replayr.tv";
}

export function clipShareUrl(slug: string): string {
  return `${publicShareUrl()}/c/${slug}`;
}

export function apiUrl(path: string): string {
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${publicAppUrl()}${suffix}`;
}
