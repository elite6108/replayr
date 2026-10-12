import { apiUrl } from "./supabase";

export type DownloadPlatform = "windows" | "macos" | "ios" | "android";
export type DownloadSurface = "homepage" | "header" | "pricing" | "download_page" | "other";
export type AnalyticsConsent = "unset" | "allowed" | "denied";

const WEB_EVENT_PROPERTIES = {
  "app.opened": [],
  "screen.viewed": ["screen"],
  "app.download_clicked": ["platform", "surface"],
  "clip.shared": ["channel"],
  "pricing.viewed": ["surface"],
} as const;

let consentToken: string | null = null;
let consentState: AnalyticsConsent = "unset";
let appOpenedToken: string | null = null;

export function trackWebEvent(
  eventName: string,
  properties: Record<string, string | number | boolean | undefined> = {},
  token?: string | null,
) {
  if (!token) return;
  if (token !== consentToken) {
    void getWebAnalyticsConsent(token)
      .then((consent) => {
        if (consent === "allowed") trackWebEvent(eventName, properties, token);
      })
      .catch(() => undefined);
    return;
  }
  if (consentState !== "allowed") return;
  if (!(eventName in WEB_EVENT_PROPERTIES)) return;
  const allowed = new Set(WEB_EVENT_PROPERTIES[eventName as keyof typeof WEB_EVENT_PROPERTIES] as readonly string[]);
  const clean: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (value == null) continue;
    if (!allowed.has(key)) continue;
    clean[key] = typeof value === "string" ? value.slice(0, 80) : value;
  }
  void fetch(apiUrl("/v1/analytics/events"), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      eventName,
      platform: "web",
      idempotencyKey: `web:${crypto.randomUUID()}`,
      properties: clean,
    }),
    keepalive: true,
  }).catch(() => undefined);
}

export function trackAppDownloadClick(input: { platform: DownloadPlatform; surface: DownloadSurface }) {
  trackWebEvent("app.download_clicked", input, consentToken);
}

export async function getWebAnalyticsConsent(token: string, force = false): Promise<AnalyticsConsent> {
  if (!force && token === consentToken) return consentState;
  const response = await fetch(apiUrl("/v1/analytics/consent"), {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error("Could not load analytics privacy.");
  const body = (await response.json()) as { consent?: AnalyticsConsent };
  consentToken = token;
  consentState = body.consent === "allowed" || body.consent === "denied" ? body.consent : "unset";
  return consentState;
}

export async function setWebAnalyticsConsent(
  token: string,
  consent: "allowed" | "denied",
): Promise<AnalyticsConsent> {
  const response = await fetch(apiUrl("/v1/analytics/consent"), {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ consent }),
  });
  if (!response.ok) throw new Error("Could not update analytics privacy.");
  consentToken = token;
  consentState = consent;
  return consent;
}

export function trackWebAppOpened(token: string): void {
  if (appOpenedToken === token) return;
  appOpenedToken = token;
  trackWebEvent("app.opened", {}, token);
}
