import { apiUrl } from "./supabase";

const ANON_KEY = "replayr_aid";
const TOUCH_KEY = "replayr_first_touch";
const LAST_KEY = "replayr_last_touch";

export type StoredTouch = {
  source?: string | null;
  medium?: string | null;
  campaign?: string | null;
  content?: string | null;
  term?: string | null;
  referrer?: string | null;
  landingPage?: string | null;
  at?: string | null;
};

function randomAnonymousId() {
  return crypto.randomUUID();
}

function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

function writeCookie(name: string, value: string) {
  if (typeof document === "undefined") return;
  document.cookie = `${name}=${encodeURIComponent(value)}; Max-Age=34560000; Path=/; SameSite=Lax`;
}

export function getAnonymousId(): string {
  if (typeof window === "undefined") return "";
  const existing = window.localStorage.getItem(ANON_KEY) || readCookie(ANON_KEY);
  if (existing && existing.length >= 8) {
    window.localStorage.setItem(ANON_KEY, existing);
    writeCookie(ANON_KEY, existing);
    return existing;
  }
  const next = randomAnonymousId();
  window.localStorage.setItem(ANON_KEY, next);
  writeCookie(ANON_KEY, next);
  return next;
}

function readTouch(key: string): StoredTouch | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as StoredTouch) : null;
  } catch {
    return null;
  }
}

function currentTouch(): StoredTouch {
  const params = new URLSearchParams(window.location.search);
  const referrer = document.referrer && !document.referrer.includes(window.location.host) ? document.referrer.slice(0, 80) : null;
  return {
    source: params.get("utm_source")?.slice(0, 80) || null,
    medium: params.get("utm_medium")?.slice(0, 80) || null,
    campaign: params.get("utm_campaign")?.slice(0, 80) || null,
    content: params.get("utm_content")?.slice(0, 80) || null,
    term: params.get("utm_term")?.slice(0, 80) || null,
    referrer,
    landingPage: `${window.location.pathname}${window.location.search}`.slice(0, 160),
    at: new Date().toISOString(),
  };
}

function hasAttribution(touch: StoredTouch | null): boolean {
  if (!touch) return false;
  return Boolean(touch.source || touch.medium || touch.campaign || touch.referrer || touch.landingPage);
}

export function captureWebAttribution() {
  if (typeof window === "undefined") return;
  getAnonymousId();
  const incoming = currentTouch();
  const first = readTouch(TOUCH_KEY);
  if (!first && hasAttribution(incoming)) {
    window.localStorage.setItem(TOUCH_KEY, JSON.stringify(incoming));
  }
  if (incoming.source || incoming.campaign) {
    window.localStorage.setItem(LAST_KEY, JSON.stringify({ source: incoming.source, campaign: incoming.campaign, at: incoming.at }));
  }
}

export function firstTouch(): StoredTouch | null {
  return readTouch(TOUCH_KEY);
}

export function lastTouch(): StoredTouch | null {
  return readTouch(LAST_KEY);
}

export function associateWebAcquisition(token: string | null) {
  if (!token || typeof window === "undefined") return;
  const first = firstTouch();
  const last = lastTouch();
  void fetch(apiUrl("/v1/analytics/identify"), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    keepalive: true,
    body: JSON.stringify({
      anonymousId: getAnonymousId(),
      firstTouch: first,
      lastTouch: last,
    }),
  }).catch(() => undefined);
}
