import Constants from "expo-constants";
import * as Crypto from "expo-crypto";
import { Platform } from "react-native";
import { apiUrl } from "./supabase";

export type AnalyticsConsent = "unset" | "allowed" | "denied";

const MOBILE_EVENT_PROPERTIES = {
  "app.opened": [],
  "screen.viewed": ["screen"],
  "clip.shared": ["channel"],
  "clip.editor_opened": ["editor_mode"],
  "clip.edit_saved": ["editor_mode"],
  "clip.upload_started": ["source"],
  "screenshot.local_created": ["source", "width_bucket", "height_bucket"],
  "screenshot.local_deleted": ["source"],
} as const;

let activeToken: string | null = null;
let consentState: AnalyticsConsent = "unset";
let appOpenedToken: string | null = null;

export async function getMobileAnalyticsConsent(token: string, force = false): Promise<AnalyticsConsent> {
  if (!force && token === activeToken) return consentState;
  const response = await fetch(apiUrl("/v1/analytics/consent"), {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error("Could not load analytics privacy.");
  const body = (await response.json()) as { consent?: AnalyticsConsent };
  activeToken = token;
  consentState = body.consent === "allowed" || body.consent === "denied" ? body.consent : "unset";
  if (consentState === "allowed") trackMobileAppOpened(token);
  return consentState;
}

export async function setMobileAnalyticsConsent(
  token: string,
  consent: "allowed" | "denied",
): Promise<AnalyticsConsent> {
  const response = await fetch(apiUrl("/v1/analytics/consent"), {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ consent }),
  });
  if (!response.ok) throw new Error("Could not update analytics privacy.");
  activeToken = token;
  consentState = consent;
  if (consent === "allowed") {
    appOpenedToken = null;
    trackMobileAppOpened(token);
  }
  return consent;
}

export function trackMobileEvent(
  token: string | null | undefined,
  eventName: string,
  properties: Record<string, string | number | boolean | undefined> = {},
): void {
  if (!token || token !== activeToken || consentState !== "allowed") return;
  if (!(eventName in MOBILE_EVENT_PROPERTIES)) return;
  const allowed = new Set(MOBILE_EVENT_PROPERTIES[eventName as keyof typeof MOBILE_EVENT_PROPERTIES] as readonly string[]);
  const clean: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (value == null || !allowed.has(key)) continue;
    clean[key] = typeof value === "string" ? value.slice(0, 80) : value;
  }
  const id = Crypto.randomUUID();
  void fetch(apiUrl("/v1/analytics/events"), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      eventName,
      platform: Platform.OS === "android" ? "android" : "ios",
      appVersion: Constants.expoConfig?.version,
      idempotencyKey: `mobile:${id}`,
      properties: clean,
    }),
  }).catch(() => undefined);
}

export function trackMobileAppOpened(token: string): void {
  if (appOpenedToken === token) return;
  appOpenedToken = token;
  trackMobileEvent(token, "app.opened");
}

export function normalizedMobileScreen(pathname: string): string {
  if (pathname === "/" || pathname === "/index") return "home";
  if (pathname.startsWith("/library")) return "library";
  if (pathname.startsWith("/folders")) return "folders";
  if (pathname.startsWith("/messages")) return "messages";
  if (pathname.startsWith("/editor")) return "editor";
  if (pathname.startsWith("/c/")) return "clip";
  if (pathname.startsWith("/s/")) return "screenshot";
  if (pathname.startsWith("/u/")) return "profile";
  if (pathname.startsWith("/game/") || pathname.startsWith("/games")) return "games";
  if (pathname.startsWith("/staff")) return "staff";
  if (pathname.startsWith("/settings")) return "settings";
  if (pathname.startsWith("/search")) return "search";
  if (pathname.startsWith("/friends")) return "friends";
  if (pathname.startsWith("/signin") || pathname.startsWith("/auth/")) return "auth";
  return "other";
}
