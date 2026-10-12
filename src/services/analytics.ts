import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { publicApiUrl } from "../branding";
import { useAuthStore } from "../stores/authStore";
import type { LocalClip } from "../types/clip";
import { clipWebcamSource } from "../utils/clips";

const CLIP_SAVE_KINDS = new Set(["clip", "recording", "trim", "short"]);
const DESKTOP_EVENT_PROPERTIES = {
  "app.opened": [],
  "screen.viewed": ["screen"],
  "capture.started": ["capture_type"],
  "capture.stopped": ["capture_type", "duration_bucket"],
  "replay.enabled": [],
  "replay.disabled": [],
  "clip.saved": [
    "duration_bucket",
    "instant_replay",
    "webcam_enabled",
    "cloud",
    "cloud_uploaded",
    "save_kind",
    "capture_type",
    "quality_preset",
    "source",
    "filter_id",
  ],
  "clip.local_deleted": ["source"],
  "clip.save_failed": ["failure_category"],
  "clip.upload_started": ["source"],
  "clip.shared": ["channel", "filter_id"],
  "clip.editor_opened": ["editor_mode", "duration_bucket", "webcam_enabled"],
  "clip.edit_saved": ["editor_mode"],
  "clip.rendered": ["render_kind", "folder", "filter_id"],
  "clip.render_failed": ["render_type", "error_category"],
  "screenshot.local_created": ["source", "width_bucket", "height_bucket"],
  "screenshot.local_deleted": ["source"],
  "visual.filter_selected": ["filter_id"],
  "visual.filter_applied": ["filter_id"],
  "visual.filter_rendered": ["filter_id", "source"],
} as const;

export type AnalyticsConsent = "unset" | "allowed" | "denied";

type OutboxItem = {
  id: string;
  eventName: string;
  payloadJson: string;
  occurredAt: string;
  attempts: number;
};

let sessionId = crypto.randomUUID();
let appOpenedSent = false;
let listenersStarted = false;
let lastSaveFailureKey = "";
let flushing = false;
const consentByUser = new Map<string, AnalyticsConsent>();

export function analyticsSessionId() {
  return sessionId;
}

function durationBucket(ms: number | null | undefined): string | undefined {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return undefined;
  if (ms < 15_000) return "0-15s";
  if (ms < 30_000) return "15-30s";
  if (ms < 60_000) return "30-60s";
  if (ms < 120_000) return "1-2m";
  if (ms < 300_000) return "2-5m";
  return "5m+";
}

function saveFailureCategory(message: string): string {
  const text = message.toLowerCase();
  if (text.includes("space") || text.includes("disk")) return "disk";
  if (text.includes("permission") || text.includes("access") || text.includes("denied")) return "permission";
  if (text.includes("cancel")) return "cancelled";
  return "save_failed";
}

async function appVersion(): Promise<string | undefined> {
  try {
    const { getVersion } = await import("@tauri-apps/api/app");
    return await getVersion();
  } catch {
    return undefined;
  }
}

export async function trackDesktopEvent(
  eventName: string,
  properties: Record<string, string | number | boolean | undefined> = {},
  extras: { idempotencyKey?: string } = {},
) {
  if (!(eventName in DESKTOP_EVENT_PROPERTIES)) return;
  const identity = desktopIdentity();
  if (!identity || consentByUser.get(identity.userId) !== "allowed") return;
  const allowed = new Set(
    DESKTOP_EVENT_PROPERTIES[eventName as keyof typeof DESKTOP_EVENT_PROPERTIES] as readonly string[],
  );
  const clean: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (value == null) continue;
    if (!allowed.has(key)) continue;
    clean[key] = typeof value === "string" ? value.slice(0, 80) : value;
  }
  const version = await appVersion();
  const occurredAt = new Date().toISOString();
  const id = crypto.randomUUID();
  const payloadJson = JSON.stringify({
    eventName,
    sessionId,
    idempotencyKey: extras.idempotencyKey || `desktop:${id}`,
    occurredAt,
    platform: "windows",
    os: "windows",
    appVersion: version,
    properties: clean,
  });
  try {
    await invoke("analytics_outbox_enqueue", {
      id,
      userId: identity.userId,
      eventName,
      payloadJson,
      occurredAt,
    });
    await flushDesktopAnalyticsOutbox();
  } catch {
    await sendAnalyticsPayload(identity.token, payloadJson).catch(() => undefined);
  }
}

export async function getDesktopAnalyticsConsent(force = false): Promise<AnalyticsConsent> {
  const identity = desktopIdentity();
  if (!identity) return "unset";
  const cached = consentByUser.get(identity.userId);
  if (cached && !force) return cached;
  const response = await fetch(`${publicApiUrl()}/v1/analytics/consent`, {
    headers: { authorization: `Bearer ${identity.token}` },
  });
  if (!response.ok) throw new Error("Could not load analytics privacy.");
  const body = (await response.json()) as { consent?: AnalyticsConsent };
  const consent = body.consent === "allowed" || body.consent === "denied" ? body.consent : "unset";
  consentByUser.set(identity.userId, consent);
  if (consent === "allowed") {
    trackAppOpenedOnce();
    void flushDesktopAnalyticsOutbox();
  }
  return consent;
}

export async function setDesktopAnalyticsConsent(consent: "allowed" | "denied"): Promise<AnalyticsConsent> {
  const identity = desktopIdentity();
  if (!identity) throw new Error("Sign in to change analytics privacy.");
  const response = await fetch(`${publicApiUrl()}/v1/analytics/consent`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${identity.token}`,
    },
    body: JSON.stringify({ consent }),
  });
  if (!response.ok) throw new Error("Could not update analytics privacy.");
  consentByUser.set(identity.userId, consent);
  if (consent === "denied") {
    await invoke("analytics_outbox_clear", { userId: identity.userId }).catch(() => undefined);
  } else {
    appOpenedSent = false;
    trackAppOpenedOnce();
    void flushDesktopAnalyticsOutbox();
  }
  return consent;
}

export async function flushDesktopAnalyticsOutbox(): Promise<void> {
  if (flushing) return;
  const identity = desktopIdentity();
  if (!identity || consentByUser.get(identity.userId) !== "allowed") return;
  flushing = true;
  try {
    const items = await invoke<OutboxItem[]>("analytics_outbox_list", {
      userId: identity.userId,
      limit: 50,
    });
    for (const item of items) {
      let response: Response;
      try {
        response = await sendAnalyticsPayload(identity.token, item.payloadJson);
      } catch {
        await invoke("analytics_outbox_mark_attempt", { id: item.id, userId: identity.userId }).catch(() => undefined);
        break;
      }
      if (response.ok || (response.status >= 400 && response.status < 500)) {
        await invoke("analytics_outbox_delete", { id: item.id, userId: identity.userId });
      } else {
        await invoke("analytics_outbox_mark_attempt", { id: item.id, userId: identity.userId }).catch(() => undefined);
        break;
      }
    }
  } finally {
    flushing = false;
  }
}

function desktopIdentity(): { userId: string; token: string } | null {
  const session = useAuthStore.getState().session;
  return session?.user.id && session.access_token
    ? { userId: session.user.id, token: session.access_token }
    : null;
}

function sendAnalyticsPayload(token: string, payloadJson: string): Promise<Response> {
  return fetch(`${publicApiUrl()}/v1/analytics/events`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    keepalive: true,
    body: payloadJson,
  });
}

export function trackAppOpenedOnce() {
  if (appOpenedSent) return;
  const identity = desktopIdentity();
  if (!identity || consentByUser.get(identity.userId) !== "allowed") return;
  appOpenedSent = true;
  void trackDesktopEvent("app.opened", {}, { idempotencyKey: `app.opened:${sessionId}` }).catch(() => undefined);
}

export function trackClipSaved(input: { localId: string; kind: string; clip?: LocalClip | null }) {
  if (!CLIP_SAVE_KINDS.has(input.kind)) return;
  void import("../stores/settingsStore").then(({ useSettingsStore }) => {
    const settings = useSettingsStore.getState().settings;
    const filterId = settings.recordingVisuals.filter;
    void trackDesktopEvent(
      "clip.saved",
      {
        duration_bucket: durationBucket(input.clip?.durationMs),
        instant_replay: input.kind === "clip",
        webcam_enabled: Boolean(clipWebcamSource(input.clip)),
        cloud: false,
        cloud_uploaded: false,
        save_kind: input.kind,
        capture_type: input.kind === "clip" ? "instant_replay" : "manual_clip",
        quality_preset: settings.bitrate,
        source: "desktop",
        filter_id: filterId,
      },
      { idempotencyKey: `clip.saved:${input.localId}` },
    ).catch(() => undefined);
    if (filterId && filterId !== "none") {
      void trackDesktopEvent("visual.filter_rendered", { filter_id: filterId, source: "clip.saved" }).catch(() => undefined);
    }
  });
}

export function trackClipSaveFailed(message: string) {
  const category = saveFailureCategory(message);
  const key = `${category}:${message.slice(0, 80)}`;
  if (key === lastSaveFailureKey) return;
  lastSaveFailureKey = key;
  void trackDesktopEvent("clip.save_failed", {
    failure_category: category,
  }).catch(() => undefined);
}

export function trackEditorOpened(input: {
  localId: string;
  folderId?: string | null;
  editId?: string | null;
  durationMs?: number | null;
  webcamEnabled?: boolean;
}) {
  void trackDesktopEvent(
    "clip.editor_opened",
    {
      editor_mode: input.folderId ? "folder" : "personal",
      duration_bucket: durationBucket(input.durationMs),
      webcam_enabled: Boolean(input.webcamEnabled),
    },
    { idempotencyKey: `clip.editor_opened:${input.editId || input.localId}:${sessionId}` },
  ).catch(() => undefined);
}

function renderFailureCategory(message: string): string {
  const text = message.toLowerCase();
  if (text.includes("cancel")) return "cancelled";
  if (text.includes("space") || text.includes("disk")) return "disk";
  if (text.includes("permission") || text.includes("access") || text.includes("denied")) return "permission";
  return "render_failed";
}

export function trackClipRenderFailed(input: { kind: "short" | "folder_edit"; message: string }) {
  const category = renderFailureCategory(input.message);
  if (category === "cancelled") return;
  void trackDesktopEvent("clip.render_failed", {
    render_type: input.kind,
    error_category: category,
  }).catch(() => undefined);
}

export function trackClipRendered(input: { kind: "short" | "folder_edit"; localId?: string; folderId?: string | null }) {
  void import("../stores/settingsStore").then(({ useSettingsStore }) => {
    const filterId = useSettingsStore.getState().settings.recordingVisuals.filter;
    void trackDesktopEvent("clip.rendered", {
      render_kind: input.kind,
      folder: Boolean(input.folderId),
      filter_id: filterId,
    }).catch(() => undefined);
    if (filterId && filterId !== "none") {
      void trackDesktopEvent("visual.filter_rendered", { filter_id: filterId, source: "clip.rendered" }).catch(() => undefined);
    }
  });
}

export function trackFilterSelected(filterId: string) {
  void trackDesktopEvent("visual.filter_selected", { filter_id: filterId }).catch(() => undefined);
}

export function trackFilterApplied(filterId: string) {
  void trackDesktopEvent("visual.filter_applied", { filter_id: filterId }).catch(() => undefined);
}

export function trackClipShared(input: { channel: "dm" | "copy_link"; slug?: string }) {
  void import("../stores/settingsStore").then(({ useSettingsStore }) => {
    const filterId = useSettingsStore.getState().settings.recordingVisuals.filter;
    void trackDesktopEvent("clip.shared", {
      channel: input.channel,
      filter_id: filterId && filterId !== "none" ? filterId : undefined,
    }).catch(() => undefined);
  });
}

export function trackLocalClipDeleted() {
  void trackDesktopEvent("clip.local_deleted", { source: "desktop_library" }).catch(() => undefined);
}

export function trackLocalScreenshotCreated(width: number, height: number) {
  void trackDesktopEvent("screenshot.local_created", {
    source: "desktop_capture",
    width_bucket: dimensionBucket(width),
    height_bucket: dimensionBucket(height),
  }).catch(() => undefined);
}

export function trackLocalScreenshotDeleted() {
  void trackDesktopEvent("screenshot.local_deleted", { source: "desktop_library" }).catch(() => undefined);
}

function dimensionBucket(value: number): string {
  if (value <= 720) return "small";
  if (value <= 1440) return "medium";
  if (value <= 2160) return "large";
  return "very_large";
}

export async function installDesktopAnalytics() {
  if (listenersStarted) return;
  listenersStarted = true;
  installDesktopPresence();
  let activeUserId = desktopIdentity()?.userId ?? null;
  const syncIdentity = () => {
    const identity = desktopIdentity();
    if (!identity) return;
    if (identity.userId !== activeUserId) {
      activeUserId = identity.userId;
      sessionId = crypto.randomUUID();
      appOpenedSent = false;
    }
    void getDesktopAnalyticsConsent().catch(() => undefined);
  };
  syncIdentity();
  useAuthStore.subscribe(syncIdentity);
  try {
    await listen<{ phase?: string; message?: string }>("clip-save", (event) => {
      if (event.payload.phase === "failed" && event.payload.message) {
        trackClipSaveFailed(event.payload.message);
      }
    });
  } catch {
    /* overlay or non-tauri */
  }
}

function installDesktopPresence() {
  const beat = () => {
    const token = useAuthStore.getState().session?.access_token;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    const path = typeof window !== "undefined" ? window.location.hash || window.location.pathname || "/app" : "/app";
    void fetch(`${publicApiUrl()}/v1/presence/ping`, {
      method: "POST",
      headers,
      keepalive: true,
      body: JSON.stringify({
        path: path.slice(0, 160),
        sessionId,
        surface: "desktop",
      }),
    }).catch(() => undefined);
  };
  beat();
  if (typeof window !== "undefined") {
    window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      beat();
    }, 25_000);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") beat();
    });
  }
}

export function associateDesktopAcquisition(token: string | null) {
  if (!token) return;
  void fetch(`${publicApiUrl()}/v1/analytics/identify`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ platform: "windows" }),
    keepalive: true,
  }).catch(() => undefined);
}
