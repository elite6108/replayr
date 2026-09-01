import type { Env } from "./env";
import { HttpError, json } from "./http";
import { requireUser } from "./shared";

const MAX_ATTR = 80;

export const NORMALIZED_SOURCES = [
  "x",
  "discord",
  "google",
  "youtube",
  "tiktok",
  "reddit",
  "direct",
  "organic_search",
  "referral",
  "other",
  "unknown",
] as const;

export type NormalizedSource = (typeof NORMALIZED_SOURCES)[number];

export type AttributionTouch = {
  source?: string | null;
  medium?: string | null;
  campaign?: string | null;
  content?: string | null;
  term?: string | null;
  referrer?: string | null;
  landingPage?: string | null;
  at?: string | null;
};

const SEARCH_HOSTS = new Set([
  "google.com",
  "www.google.com",
  "bing.com",
  "www.bing.com",
  "duckduckgo.com",
  "yahoo.com",
  "search.yahoo.com",
]);

export function sanitizeAttributionValue(value: unknown, max = MAX_ATTR): string | null {
  if (value == null) return null;
  const text = String(value)
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, max);
  return text || null;
}

export function referrerHost(referrer: string | null | undefined): string | null {
  if (!referrer) return null;
  try {
    return new URL(referrer).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

export function normalizeAcquisitionSource(input: AttributionTouch): NormalizedSource {
  const source = (input.source || "").trim().toLowerCase();
  const medium = (input.medium || "").trim().toLowerCase();
  const host = referrerHost(input.referrer);

  if (!source && !medium && !host && !input.landingPage) return "unknown";

  if (
    source === "x" ||
    source === "twitter" ||
    source === "t.co" ||
    host === "x.com" ||
    host === "twitter.com" ||
    host === "t.co"
  ) {
    return "x";
  }
  if (source === "discord" || host === "discord.com" || host === "discord.gg") return "discord";
  if (source === "google" || source === "google.com" || host === "google.com") return "google";
  if (source === "youtube" || source === "youtu.be" || host === "youtube.com" || host === "youtu.be") {
    return "youtube";
  }
  if (source === "tiktok" || host === "tiktok.com") return "tiktok";
  if (source === "reddit" || host === "reddit.com") return "reddit";

  if (medium === "organic" || (host && SEARCH_HOSTS.has(host) && !source)) return "organic_search";
  if (source === "direct" || medium === "none" || medium === "(none)") return "direct";
  if (!source && !medium && !host && input.landingPage) return "direct";
  if (!source && host) return "referral";
  if (source) return "other";
  return "unknown";
}

export function sourceLabel(source: NormalizedSource): string {
  switch (source) {
    case "x":
      return "X";
    case "discord":
      return "Discord";
    case "google":
      return "Google";
    case "youtube":
      return "YouTube";
    case "tiktok":
      return "TikTok";
    case "reddit":
      return "Reddit";
    case "direct":
      return "Direct";
    case "organic_search":
      return "Organic Search";
    case "referral":
      return "Referral";
    case "other":
      return "Other";
    default:
      return "Unknown";
  }
}

export function firstTouchLocked<T extends Record<string, unknown>>(
  current: T | null,
  incoming: T,
): T {
  if (!current) return incoming;
  return current;
}

export function attributionCoverage(known: number, total: number): number | null {
  if (total <= 0) return null;
  return known / total;
}

export function installerSignupConversion(input: {
  attributedSignups: number;
  installerDownloads: number;
  userLevelMatches: number;
}): { userLevel: number | null; periodLevel: number | null; label: "user-level" | "period-level ratio" | null } {
  if (input.userLevelMatches > 0 && input.installerDownloads > 0) {
    return {
      userLevel: input.userLevelMatches / input.installerDownloads,
      periodLevel: input.attributedSignups / input.installerDownloads,
      label: "user-level",
    };
  }
  if (input.installerDownloads > 0) {
    return {
      userLevel: null,
      periodLevel: input.attributedSignups / input.installerDownloads,
      label: "period-level ratio",
    };
  }
  return { userLevel: null, periodLevel: null, label: null };
}

export function parseReplayrAnonymousId(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(/(?:^|;\s*)replayr_aid=([^;]+)/i);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]).slice(0, 160);
  } catch {
    return match[1].slice(0, 160);
  }
}

export function isSafeAnonymousId(value: string | null | undefined): value is string {
  if (!value) return false;
  return /^[A-Za-z0-9._:-]{8,160}$/.test(value);
}

export async function handleAnalyticsIdentify(request: Request, env: Env) {
  const user = await requireUser(request, env);
  const body = (await request.json().catch(() => ({}))) as {
    anonymousId?: unknown;
    firstTouch?: AttributionTouch;
    lastTouch?: AttributionTouch;
  };
  const anonymousId = isSafeAnonymousId(typeof body.anonymousId === "string" ? body.anonymousId : null)
    ? body.anonymousId
    : null;
  const first = body.firstTouch ?? {};
  const last = body.lastTouch ?? {};
  const normalized = normalizeAcquisitionSource({
    source: sanitizeAttributionValue(first.source),
    medium: sanitizeAttributionValue(first.medium),
    referrer: sanitizeAttributionValue(first.referrer, 160),
    landingPage: sanitizeAttributionValue(first.landingPage, 160),
  });
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new HttpError(503, "Analytics ingest is not configured.");
  if (anonymousId) {
    await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/capture_anonymous_first_touch`, {
      method: "POST",
      headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        p_anonymous_id: anonymousId,
        p_source: sanitizeAttributionValue(first.source),
        p_medium: sanitizeAttributionValue(first.medium),
        p_campaign: sanitizeAttributionValue(first.campaign),
        p_content: sanitizeAttributionValue(first.content),
        p_term: sanitizeAttributionValue(first.term),
        p_referrer: sanitizeAttributionValue(first.referrer, 160),
        p_landing_page: sanitizeAttributionValue(first.landingPage, 160),
        p_normalized_source: normalized === "unknown" ? null : normalized,
        p_first_touch_at: sanitizeAttributionValue(first.at, 40),
        p_installer_downloaded: false,
      }),
    }).catch(() => undefined);
  }
  await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/upsert_user_acquisition`, {
    method: "POST",
    headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      p_user_id: user.id,
      p_anonymous_id: anonymousId,
      p_source: sanitizeAttributionValue(first.source),
      p_medium: sanitizeAttributionValue(first.medium),
      p_campaign: sanitizeAttributionValue(first.campaign),
      p_content: sanitizeAttributionValue(first.content),
      p_term: sanitizeAttributionValue(first.term),
      p_referrer: sanitizeAttributionValue(first.referrer, 160),
      p_landing_page: sanitizeAttributionValue(first.landingPage, 160),
      p_normalized_source: normalized === "unknown" ? null : normalized,
      p_first_touch_at: sanitizeAttributionValue(first.at, 40),
      p_last_source: sanitizeAttributionValue(last.source),
      p_last_campaign: sanitizeAttributionValue(last.campaign),
      p_last_touch_at: sanitizeAttributionValue(last.at, 40),
    }),
  }).catch(() => undefined);
  return json({ ok: true }, 202);
}

export function captureAnonymousFromEvent(
  env: Env,
  input: {
    anonymousId?: string | null;
    source?: string | null;
    medium?: string | null;
    campaign?: string | null;
    content?: string | null;
    term?: string | null;
    installer?: boolean;
  },
) {
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key || !isSafeAnonymousId(input.anonymousId)) return;
  const normalized = normalizeAcquisitionSource({
    source: input.source,
    medium: input.medium,
  });
  void fetch(`${env.SUPABASE_URL}/rest/v1/rpc/capture_anonymous_first_touch`, {
    method: "POST",
    headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      p_anonymous_id: input.anonymousId,
      p_source: sanitizeAttributionValue(input.source),
      p_medium: sanitizeAttributionValue(input.medium),
      p_campaign: sanitizeAttributionValue(input.campaign),
      p_content: sanitizeAttributionValue(input.content),
      p_term: sanitizeAttributionValue(input.term),
      p_normalized_source: normalized === "unknown" ? null : normalized,
      p_installer_downloaded: Boolean(input.installer),
    }),
  }).catch(() => undefined);
}
