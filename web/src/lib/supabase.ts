import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;

export function supabaseConfigured(): boolean {
  return Boolean(import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY);
}

export function getSupabase(): SupabaseClient {
  if (client) return client;
  const url = import.meta.env.VITE_SUPABASE_URL;
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error("Supabase is not configured.");
  }
  client = createClient(url, anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });
  return client;
}

export function publicAppUrl(): string {
  return (import.meta.env.VITE_PUBLIC_APP_URL || window.location.origin).replace(/\/$/, "");
}

export function clipShareUrl(slug: string): string {
  return `${publicAppUrl()}/c/${slug}`;
}

export function apiUrl(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}
