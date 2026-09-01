import { listen } from "@tauri-apps/api/event";
import { publicApiUrl } from "../branding";
import { useAuthStore } from "../stores/authStore";
import type { LocalClip } from "../types/clip";
import { clipWebcamSource } from "../utils/clips";

const CLIP_SAVE_KINDS = new Set(["clip", "recording", "trim", "short"]);

let sessionId = crypto.randomUUID();
let appOpenedSent = false;
let listenersStarted = false;
let lastSaveFailureKey = "";

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
  const clean: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (value == null) continue;
    if (key === "path" || key === "filePath" || key === "filename") continue;
    clean[key] = typeof value === "string" ? value.slice(0, 200) : value;
  }
  const token = useAuthStore.getState().session?.access_token;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const version = await appVersion();
  await fetch(`${publicApiUrl()}/v1/analytics/events`, {
    method: "POST",
    headers,
    keepalive: true,
    body: JSON.stringify({
      eventName,
      sessionId,
      idempotencyKey: extras.idempotencyKey,
      platform: "windows",
      os: "windows",
      appVersion: version,
      properties: clean,
    }),
  });
}

export function trackAppOpenedOnce() {
  if (appOpenedSent) return;
  appOpenedSent = true;
  void trackDesktopEvent("app.opened", {}, { idempotencyKey: `app.opened:${sessionId}` }).catch(() => undefined);
}

export function trackClipSaved(input: { localId: string; kind: string; clip?: LocalClip | null }) {
  if (!CLIP_SAVE_KINDS.has(input.kind)) return;
  void import("../stores/settingsStore").then(({ useSettingsStore }) => {
    const filterId = useSettingsStore.getState().settings.recordingVisuals.filter;
    void trackDesktopEvent(
      "clip.saved",
      {
        duration_bucket: durationBucket(input.clip?.durationMs),
        game_slug: input.clip?.gameId || undefined,
        instant_replay: input.kind === "clip",
        webcam_enabled: Boolean(clipWebcamSource(input.clip)),
        cloud: false,
        save_kind: input.kind,
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

export async function installDesktopAnalytics() {
  if (listenersStarted) return;
  listenersStarted = true;
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

export function associateDesktopAcquisition(token: string | null) {
  if (!token) return;
  void fetch(`${publicApiUrl()}/v1/analytics/identify`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ platform: "windows" }),
    keepalive: true,
  }).catch(() => undefined);
}
