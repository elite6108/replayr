import { getAnonymousId } from "./attribution";
import { apiUrl, getSupabase, supabaseConfigured } from "./supabase";

const INTERVAL_MS = 25_000;
let started = false;
let timer: number | null = null;
let lastPath = "";

function surfaceForPath(path: string): "web" | "admin" {
  return path.startsWith("/admin") || path.startsWith("/staff") ? "admin" : "web";
}

export function pingWebPresence() {
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
  const path = `${window.location.pathname}${window.location.search}`.slice(0, 160);
  lastPath = path;
  void (async () => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (supabaseConfigured()) {
      try {
        const { data } = await getSupabase().auth.getSession();
        const token = data.session?.access_token;
        if (token) headers.authorization = `Bearer ${token}`;
      } catch {
        /* unconfigured or signed out */
      }
    }
    await fetch(apiUrl("/v1/presence/ping"), {
      method: "POST",
      headers,
      keepalive: true,
      body: JSON.stringify({
        path,
        anonymousId: getAnonymousId() || undefined,
        surface: surfaceForPath(window.location.pathname),
      }),
    }).catch(() => undefined);
  })();
}

export function installWebPresence() {
  if (started || typeof window === "undefined") return;
  started = true;
  pingWebPresence();
  timer = window.setInterval(pingWebPresence, INTERVAL_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") pingWebPresence();
  });
  window.addEventListener("popstate", pingWebPresence);
  window.addEventListener("beforeunload", () => {
    if (timer != null) window.clearInterval(timer);
  });
}

export function noteWebPresencePath() {
  const path = `${window.location.pathname}${window.location.search}`.slice(0, 160);
  if (path === lastPath) return;
  pingWebPresence();
}
