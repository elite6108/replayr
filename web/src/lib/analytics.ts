import { firstTouch, getAnonymousId } from "./attribution";
import { apiUrl } from "./supabase";

export type DownloadPlatform = "windows" | "macos" | "ios" | "android";
export type DownloadSurface = "homepage" | "header" | "pricing" | "download_page" | "other";

export function trackWebEvent(
  eventName: string,
  properties: Record<string, string | number | boolean | undefined> = {},
  token?: string | null,
) {
  const clean: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (value == null) continue;
    clean[key] = value;
  }
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  void fetch(apiUrl("/v1/analytics/events"), {
    method: "POST",
    headers,
    body: JSON.stringify({
      eventName,
      platform: "web",
      anonymousId: getAnonymousId() || undefined,
      properties: clean,
    }),
    keepalive: true,
  }).catch(() => undefined);
}

export function trackAppDownloadClick(input: { platform: DownloadPlatform; surface: DownloadSurface }) {
  const params = new URLSearchParams(typeof window === "undefined" ? "" : window.location.search);
  const touch = firstTouch();
  const body = {
    eventName: "app.download_clicked",
    platform: "web",
    anonymousId: getAnonymousId() || undefined,
    properties: { platform: input.platform, surface: input.surface },
    utmSource: params.get("utm_source") || touch?.source || undefined,
    utmMedium: params.get("utm_medium") || touch?.medium || undefined,
    utmCampaign: params.get("utm_campaign") || touch?.campaign || undefined,
    utmContent: params.get("utm_content") || touch?.content || undefined,
    utmTerm: params.get("utm_term") || touch?.term || undefined,
  };
  void fetch(apiUrl("/v1/analytics/events"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    keepalive: true,
  }).catch(() => undefined);
}
