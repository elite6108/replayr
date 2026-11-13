import { invoke } from "@tauri-apps/api/core";
import type { AppSettings, CameraControlName, WebcamPreviewSmoothness } from "../types/settings";
import type { AudioDevice, AudioEngineStatus, AudioSession } from "../types/audio";
import type { CapturePreviewFrame, CapturePreviewHeader } from "../types/capturePreview";
import type {
  CameraControlInfo,
  CameraDevice,
  CameraMode,
  CameraPreviewHeader,
  CameraStatus,
} from "../types/camera";
import type { LocalClip } from "../types/clip";
import type { DetectedGameSnapshot, GameCatalogEntry } from "../types/game";
import type { DiscordPresenceStatus } from "../types/discord";
import type { RecordingStatus, ReplayStatus } from "../types/recording";
import type { Screenshot } from "../types/screenshot";
import type { HotkeyFailure } from "../utils/hotkeys";
import { invokeErrorMessage } from "../utils/format";

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export async function getAllSettings(): Promise<AppSettings> {
  return withTimeout(invoke("get_all_settings"), 5000, "get_all_settings");
}

export async function setSetting(key: string, value: unknown): Promise<AppSettings> {
  return invoke("set_setting", { key, value });
}

export async function setSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  return invoke("set_settings", { patch });
}

export async function listAudioDevices(): Promise<AudioDevice[]> {
  try {
    const devices = await withTimeout(invoke<AudioDevice[]>("list_audio_devices"), 5000, "list_audio_devices");
    return Array.isArray(devices) ? devices : [];
  } catch {
    return [];
  }
}

export async function getMicLevel(): Promise<number> {
  return invoke("get_mic_level");
}

export async function stopMicMonitor(): Promise<void> {
  await invoke("stop_mic_monitor");
}

export async function resolveMicDisconnect(action: "default" | "off"): Promise<AppSettings> {
  return invoke("resolve_mic_disconnect", { action });
}

export async function listAudioSessions(): Promise<AudioSession[]> {
  try {
    const sessions = await withTimeout(invoke<AudioSession[]>("list_audio_sessions"), 5000, "list_audio_sessions");
    return Array.isArray(sessions) ? sessions : [];
  } catch {
    return [];
  }
}

export async function getAudioStatus(): Promise<AudioEngineStatus | null> {
  try {
    return await withTimeout(invoke<AudioEngineStatus>("get_audio_status"), 4000, "get_audio_status");
  } catch {
    return null;
  }
}

export async function addExtraAudioApp(exe: string, displayName: string): Promise<AppSettings> {
  return invoke("add_extra_audio_app", { exe, displayName });
}

export async function listLocalClips(limit = 80): Promise<LocalClip[]> {
  return invoke("list_local_clips", { limit });
}

export async function resetStaleUploads(): Promise<string[]> {
  return invoke("reset_stale_uploads");
}

export async function saveTrimmedClip(
  sourceLocalId: string,
  startMs: number,
  endMs: number,
  title?: string,
): Promise<LocalClip> {
  return invoke("save_trimmed_clip", {
    sourceLocalId,
    startMs: Math.round(startMs),
    endMs: Math.round(endMs),
    title,
  });
}

/** Joins several kept ranges of one local clip into a new clip (lossless stream copy). */
export async function saveSegmentedClip(
  sourceLocalId: string,
  ranges: Array<[number, number]>,
  title?: string,
): Promise<LocalClip> {
  return invoke("save_segmented_clip", {
    sourceLocalId,
    ranges: ranges.map(([startMs, endMs]) => [Math.round(startMs), Math.round(endMs)]),
    title,
  });
}

export type TreatedSectionInput = {
  startMs: number;
  endMs: number;
  gameVolume: number;
  micVolume: number;
  speed: number;
  text: string;
  textColor: string;
  textSize: number;
  textX: number;
  textY: number;
};

/** Re-encodes sections that change volume, text, or speed. Plain sections stay lossless inside the command. */
export async function saveTreatedClip(
  sourceLocalId: string,
  sections: TreatedSectionInput[],
  vertical: boolean,
  pan?: number,
  title?: string,
): Promise<LocalClip> {
  return invoke("save_treated_clip", {
    sourceLocalId,
    sections,
    vertical,
    pan: pan == null ? 0.5 : Math.max(0, Math.min(1, pan)),
    title,
  });
}

export async function extractTranscriptAudio(localId: string): Promise<{
  durationMs: number;
  parts: { path: string; startMs: number; durationMs: number }[];
}> {
  return invoke("extract_transcript_audio", { localId });
}

export async function discardTranscriptAudio(localId: string): Promise<void> {
  return invoke("discard_transcript_audio", { localId });
}

export async function saveShortClip(
  sourceLocalId: string,
  startMs: number,
  endMs: number,
  pan?: number,
  title?: string,
): Promise<LocalClip> {
  return invoke("save_short_clip", {
    sourceLocalId,
    startMs: Math.round(startMs),
    endMs: Math.round(endMs),
    pan: pan == null ? 0.5 : Math.max(0, Math.min(1, pan)),
    title,
  });
}

export async function setClipEditorCrop(localId: string, pan: number): Promise<LocalClip> {
  return invoke("set_clip_editor_crop", {
    localId,
    pan: Math.max(0, Math.min(1, pan)),
  });
}

export async function setClipSourceLayout(
  localId: string,
  sourceInstanceId: string,
  layout: { placement: string; shape: string; width: number; x?: number | null; y?: number | null },
): Promise<LocalClip> {
  return invoke("set_clip_source_layout", {
    localId,
    sourceInstanceId,
    layout: {
      placement: layout.placement,
      shape: layout.shape,
      width: layout.width,
      x: layout.x ?? null,
      y: layout.y ?? null,
    },
  });
}

export async function shareLocalClip(options: { localId?: string; filePath?: string }): Promise<string> {
  return invoke("share_local_clip", options);
}

export async function prepareLocalClipPlayback(localId: string): Promise<string> {
  return invoke("prepare_local_clip_playback", { localId });
}

export async function listClipFilmstrip(
  localId: string,
  count = 12,
): Promise<Array<{ path: string; atMs: number }>> {
  try {
    const frames = await invoke<Array<{ path: string; atMs: number }>>("list_clip_filmstrip", { localId, count });
    return Array.isArray(frames) ? frames : [];
  } catch (caught) {
    console.warn("list_clip_filmstrip failed", caught);
    return [];
  }
}

export async function getClipWaveform(localId: string, buckets = 800): Promise<number[]> {
  try {
    const peaks = await invoke<number[]>("get_clip_waveform", { localId, buckets });
    return Array.isArray(peaks) ? peaks : [];
  } catch (caught) {
    console.warn("get_clip_waveform failed", caught);
    return [];
  }
}

export async function renameLocalClip(localId: string, title: string): Promise<LocalClip> {
  return invoke("rename_local_clip", { localId, title });
}

export async function setLocalClipDescription(localId: string, description: string): Promise<LocalClip> {
  return invoke("set_local_clip_description", { localId, description });
}

export async function setLocalClipTags(localId: string, tags: string[]): Promise<LocalClip> {
  return invoke("set_local_clip_tags", { localId, tags });
}

export async function setLocalClipFavorite(localId: string, favorite: boolean): Promise<LocalClip> {
  return invoke("set_local_clip_favorite", { localId, favorite });
}

export async function deleteLocalClip(localId: string): Promise<void> {
  await invoke("delete_local_clip", { localId });
  void import("./analytics").then(({ trackLocalClipDeleted }) => trackLocalClipDeleted());
}

export async function revealLocalClip(localId: string): Promise<void> {
  return invoke("reveal_local_clip", { localId });
}

export async function exportLocalClip(options: {
  dest: string;
  localId?: string;
  source?: string;
}): Promise<void> {
  return invoke("export_local_clip", options);
}

export async function downloadUrlToFile(
  url: string,
  dest: string,
  options?: { skipWatermark?: boolean; accessToken?: string | null },
): Promise<void> {
  return invoke("download_url_to_file", {
    url,
    dest,
    skipWatermark: options?.skipWatermark ?? false,
    accessToken: options?.accessToken ?? null,
  });
}

export async function uploadLocalClip(localId: string, accessToken: string, apiBase: string): Promise<LocalClip> {
  return invoke("upload_local_clip", { localId, accessToken, apiBase });
}

export async function cancelLocalUpload(localId: string): Promise<void> {
  await invoke("cancel_local_upload", { localId });
}

export async function clearLocalUploadCancel(localId: string): Promise<void> {
  await invoke("clear_local_upload_cancel", { localId });
}

export async function deleteCloudClip(clipId: string, accessToken: string, apiBase: string): Promise<void> {
  return invoke("delete_cloud_clip", { clipId, accessToken, apiBase });
}

export async function getDefaultSaveLocation(): Promise<string> {
  return invoke("get_default_save_location");
}

export async function localCopyForCloud(cloudClipId: string): Promise<LocalClip | null> {
  return invoke("local_copy_for_cloud", { cloudClipId });
}

export async function importLinkedCloudClip(options: {
  path: string;
  title: string;
  cloudClipId: string;
  durationMs: number;
  width: number;
  height: number;
}): Promise<LocalClip> {
  return invoke("import_linked_cloud_clip", options);
}

export async function createDesktopShortcut(): Promise<void> {
  await invoke("create_desktop_shortcut");
}

export async function removeDesktopShortcut(): Promise<void> {
  await invoke("remove_desktop_shortcut");
}

export async function desktopShortcutExists(): Promise<boolean> {
  return invoke("desktop_shortcut_exists");
}

export async function listGames(): Promise<GameCatalogEntry[]> {
  return invoke("list_games");
}

export async function syncGames(games: GameCatalogEntry[]): Promise<GameCatalogEntry[]> {
  return invoke("sync_games", { games });
}

export async function getDetectedGame(): Promise<DetectedGameSnapshot> {
  return invoke("get_detected_game");
}

export async function getDiscordPresenceStatus(): Promise<DiscordPresenceStatus | null> {
  try {
    return await withTimeout(invoke<DiscordPresenceStatus>("get_discord_presence_status"), 4000, "get_discord_presence_status");
  } catch {
    return null;
  }
}

export async function startRecording(
  webcamLayout?: import("../types/clip").ClipSourceLayout | null,
): Promise<RecordingStatus> {
  const status = await invoke<RecordingStatus>("start_recording", { webcamLayout: webcamLayout ?? null });
  void import("./analytics").then(({ trackDesktopEvent }) =>
    trackDesktopEvent("capture.started", { capture_type: "recording" }),
  );
  return status;
}

export async function stopRecording(): Promise<RecordingStatus> {
  const status = await invoke<RecordingStatus>("stop_recording");
  void import("./analytics").then(({ trackDesktopEvent }) =>
    trackDesktopEvent("capture.stopped", { capture_type: "recording" }),
  );
  return status;
}

export async function startComposedRecording(
  payload: import("../recording/composition").RecordingComposition,
  webcamLayout?: import("../types/clip").ClipSourceLayout | null,
): Promise<RecordingStatus> {
  const status = await invoke<RecordingStatus>("start_composed_recording", { payload, webcamLayout: webcamLayout ?? null });
  void import("./analytics").then(({ trackDesktopEvent }) =>
    trackDesktopEvent("capture.started", { capture_type: "composed_recording" }),
  );
  return status;
}

/** Keeps the toggle hotkey and tray recording the same layout as the Record page. */
export async function setRecordScene(
  payload: import("../recording/composition").RecordingComposition,
  webcamLayout?: import("../types/clip").ClipSourceLayout | null,
): Promise<void> {
  await invoke("set_record_scene", { payload, webcamLayout: webcamLayout ?? null });
}

export async function stopComposedRecording(): Promise<RecordingStatus> {
  const status = await invoke<RecordingStatus>("stop_composed_recording");
  void import("./analytics").then(({ trackDesktopEvent }) =>
    trackDesktopEvent("capture.stopped", { capture_type: "composed_recording" }),
  );
  return status;
}

export async function getRecordingStatus(): Promise<RecordingStatus> {
  return invoke("get_recording_status");
}

export async function getReplayStatus(): Promise<ReplayStatus> {
  return invoke("get_replay_status");
}

export async function saveClip(): Promise<string> {
  return invoke("save_clip");
}

export async function saveScreenshot(): Promise<string> {
  return invoke("save_screenshot");
}

/** Start a drag-to-select screenshot. Replayr hides itself while the screen is frozen. */
export async function startRegionScreenshot(): Promise<void> {
  return invoke("screenshot_start");
}

export async function listScreenshots(limit?: number): Promise<Screenshot[]> {
  return invoke("screenshot_list", { limit: limit ?? null });
}

export async function backfillScreenshotThumbs(limit = 4): Promise<Screenshot[]> {
  return invoke("screenshot_backfill_thumbs", { limit });
}

export async function deleteScreenshot(id: string, deleteFile: boolean, deleteCloud = false): Promise<void> {
  return invoke("screenshot_delete", { id, deleteFile, deleteCloud });
}

export async function copyScreenshot(id: string, what: "image" | "link"): Promise<void> {
  return invoke("screenshot_copy", { id, what });
}

export async function revealScreenshot(id: string): Promise<void> {
  return invoke("screenshot_reveal", { id });
}

export async function provideScreenshotSession(
  requestId: number,
  accessToken: string | null,
  apiBase: string | null,
): Promise<void> {
  return invoke("screenshot_provide_session", { requestId, accessToken, apiBase });
}

export async function exportScreenshot(id: string, dest: string): Promise<void> {
  return invoke("screenshot_export", { id, dest });
}

export async function retryScreenshotUpload(id: string): Promise<Screenshot> {
  return invoke("screenshot_retry_upload", { id });
}

export async function syncScreenshotCloud(): Promise<Screenshot[]> {
  return invoke("screenshot_sync_cloud");
}

/** Shortcuts that could not be bound on the last sync (usually held by another app). */
export async function getHotkeyFailures(): Promise<HotkeyFailure[]> {
  return invoke("get_hotkey_failures");
}

export async function listCameraDevices(): Promise<CameraDevice[]> {
  try {
    const devices = await withTimeout(invoke<CameraDevice[]>("list_camera_devices"), 5000, "list_camera_devices");
    return Array.isArray(devices) ? devices : [];
  } catch {
    return [];
  }
}

export async function listCameraModes(deviceId: string): Promise<CameraMode[]> {
  try {
    const modes = await withTimeout(
      invoke<CameraMode[]>("list_camera_modes", { deviceId }),
      5000,
      "list_camera_modes",
    );
    return Array.isArray(modes) ? modes : [];
  } catch {
    return [];
  }
}

export async function getCameraStatus(): Promise<CameraStatus | null> {
  try {
    return await withTimeout(invoke<CameraStatus>("get_camera_status"), 4000, "get_camera_status");
  } catch {
    return null;
  }
}

let cameraPreviewClients = 0;
let cameraPreviewStopTimer: ReturnType<typeof setTimeout> | null = null;

function cancelCameraPreviewStop() {
  if (!cameraPreviewStopTimer) return;
  clearTimeout(cameraPreviewStopTimer);
  cameraPreviewStopTimer = null;
}

export async function startCameraPreview(options: {
  deviceId: string;
  width: number;
  height: number;
  fps: number;
  mirror: boolean;
  smoothness?: WebcamPreviewSmoothness;
}): Promise<CameraStatus> {
  cancelCameraPreviewStop();
  cameraPreviewClients += 1;
  try {
    const status = await invoke<CameraStatus>("start_camera_preview", options);
    if (cameraPreviewClients <= 0) {
      void invoke("stop_camera_preview").catch(() => undefined);
    }
    return status;
  } catch (caught) {
    cameraPreviewClients = Math.max(0, cameraPreviewClients - 1);
    throw caught;
  }
}

export async function stopCameraPreview(): Promise<void> {
  if (cameraPreviewClients <= 0) return;
  cameraPreviewClients -= 1;
  if (cameraPreviewClients > 0) return;
  cancelCameraPreviewStop();
  cameraPreviewStopTimer = setTimeout(() => {
    cameraPreviewStopTimer = null;
    if (cameraPreviewClients > 0) return;
    void invoke("stop_camera_preview").catch(() => undefined);
  }, 300);
}

export async function getCameraControls(deviceId: string): Promise<CameraControlInfo[]> {
  const controls = await withTimeout(
    invoke<CameraControlInfo[]>("get_camera_controls", { deviceId }),
    5000,
    "get_camera_controls",
  );
  return Array.isArray(controls) ? controls : [];
}

export async function setCameraControl(
  deviceId: string,
  name: CameraControlName,
  value: number,
  auto: boolean,
): Promise<void> {
  await withTimeout(invoke("set_camera_control", { deviceId, name, value, auto }), 5000, "set_camera_control");
}

/** Long-poll for a camera preview frame newer than `after`. `bytes` is null when none arrived in time. */
export async function waitCameraPreviewFrame(
  after: number,
  timeoutMs = 250,
): Promise<{ header: CameraPreviewHeader; bytes: Uint8Array<ArrayBuffer> | null }> {
  const body = await invoke<ArrayBuffer | number[]>("wait_camera_preview_frame", { after, timeoutMs });
  return parsePreviewBody<CameraPreviewHeader>(body);
}

let capturePreviewClients = 0;
let capturePreviewStopTimer: ReturnType<typeof setTimeout> | null = null;

function previewArgs(options: {
  mode: "game" | "desktop" | "window";
  pid?: number | null;
  monitorId?: string | null;
  window?: { title: string; className: string; exe: string };
}) {
  const args: {
    mode: "game" | "desktop" | "window";
    pid?: number;
    monitorId?: string;
    windowTitle?: string;
    windowClass?: string;
    windowExe?: string;
  } = { mode: options.mode };
  if (options.pid && options.pid > 0) args.pid = options.pid;
  if (options.monitorId) args.monitorId = options.monitorId;
  if (options.window) {
    args.windowTitle = options.window.title;
    args.windowClass = options.window.className;
    args.windowExe = options.window.exe;
  }
  return args;
}

function cancelPreviewStop() {
  if (!capturePreviewStopTimer) return;
  clearTimeout(capturePreviewStopTimer);
  capturePreviewStopTimer = null;
}

export async function startCapturePreview(options: {
  mode: "game" | "desktop" | "window";
  pid?: number | null;
  monitorId?: string | null;
  window?: { title: string; className: string; exe: string };
}): Promise<void> {
  cancelPreviewStop();
  capturePreviewClients += 1;
  try {
    await invoke("start_capture_preview", previewArgs(options));
  } catch (caught) {
    capturePreviewClients = Math.max(0, capturePreviewClients - 1);
    throw caught;
  }
}

export async function updateCapturePreview(options: {
  mode: "game" | "desktop" | "window";
  pid?: number | null;
  monitorId?: string | null;
  window?: { title: string; className: string; exe: string };
}): Promise<void> {
  if (capturePreviewClients <= 0) return;
  await invoke("start_capture_preview", previewArgs(options));
}

export async function stopCapturePreview(): Promise<void> {
  if (capturePreviewClients <= 0) return;
  capturePreviewClients -= 1;
  if (capturePreviewClients > 0) return;
  cancelPreviewStop();
  capturePreviewStopTimer = setTimeout(() => {
    capturePreviewStopTimer = null;
    if (capturePreviewClients > 0) return;
    void invoke("stop_capture_preview").catch(() => undefined);
  }, 300);
}

export async function listDisplays(): Promise<import("../recording/display/displayTypes").DisplayInfo[]> {
  return invoke("list_displays");
}

export type ListedWindow = { title: string; className: string; exe: string };

export async function listCaptureWindows(): Promise<ListedWindow[]> {
  const listed = await invoke<ListedWindow[]>("list_capture_windows");
  return Array.isArray(listed) ? listed : [];
}

export async function startLayerPreview(options: {
  sourceId: string;
  kind: "display" | "window";
  monitorId?: string | null;
  window?: { title: string; className: string; exe: string };
}): Promise<void> {
  await invoke("start_layer_preview", {
    sourceId: options.sourceId,
    kind: options.kind,
    monitorId: options.monitorId ?? null,
    windowTitle: options.window?.title ?? "",
    windowClass: options.window?.className ?? "",
    windowExe: options.window?.exe ?? "",
  });
}

export async function stopLayerPreview(sourceId: string): Promise<void> {
  await invoke("stop_layer_preview", { sourceId });
}

export async function waitLayerPreviewFrame(
  sourceId: string,
  after: number,
  timeoutMs = 250,
): Promise<{ header: { width: number; height: number; frameId: number; mimeType: string }; bytes: Uint8Array<ArrayBuffer> | null }> {
  const body = await invoke<ArrayBuffer | number[]>("wait_layer_preview_frame", { sourceId, after, timeoutMs });
  return parsePreviewBody(body);
}

export async function startExtraCameraPreview(options: {
  sourceId: string;
  deviceId: string;
  width: number;
  height: number;
  fps: number;
  mirror: boolean;
}): Promise<void> {
  await invoke("start_extra_camera_preview", options);
}

export async function stopExtraCameraPreview(sourceId: string): Promise<void> {
  await invoke("stop_extra_camera_preview", { sourceId });
}

export async function waitExtraCameraPreviewFrame(
  sourceId: string,
  after: number,
  timeoutMs = 250,
): Promise<{ header: import("../types/camera").CameraPreviewHeader; bytes: Uint8Array<ArrayBuffer> | null }> {
  const body = await invoke<ArrayBuffer | number[]>("wait_extra_camera_preview_frame", { sourceId, after, timeoutMs });
  return parsePreviewBody(body);
}

/** One flag per path: true when the file is a recordable image the preview may now load. */
export async function allowPreviewImages(paths: string[]): Promise<boolean[]> {
  return invoke("allow_preview_images", { paths });
}

export async function getCapturePreviewFrame(): Promise<CapturePreviewFrame | null> {
  try {
    const next = await invoke<
      CapturePreviewFrame & { png_base64?: string | null; frame_id?: number; mime_type?: string }
    >("get_capture_preview_frame");
    return {
      ...next,
      pngBase64: next.pngBase64 ?? next.png_base64 ?? null,
      frameId: Number(next.frameId ?? next.frame_id ?? 0),
      mimeType: next.mimeType ?? next.mime_type ?? "image/jpeg",
    };
  } catch {
    return null;
  }
}

const previewHeaderDecoder = new TextDecoder();

/** Long-poll for a preview frame newer than `after`. `bytes` is null when none arrived in time. */
export async function waitCapturePreviewFrame(
  after: number,
  timeoutMs = 250,
): Promise<{ header: CapturePreviewHeader; bytes: Uint8Array<ArrayBuffer> | null }> {
  const body = await invoke<ArrayBuffer | number[]>("wait_capture_preview_frame", { after, timeoutMs });
  return parsePreviewBody<CapturePreviewHeader>(body);
}

/** Binary preview body: little-endian u32 header length, JSON header, then image bytes. */
function parsePreviewBody<H>(body: ArrayBuffer | number[]): { header: H; bytes: Uint8Array<ArrayBuffer> | null } {
  const buffer: ArrayBuffer = body instanceof ArrayBuffer ? body : new Uint8Array(body).buffer;
  const headerLength = new DataView(buffer).getUint32(0, true);
  const header = JSON.parse(previewHeaderDecoder.decode(new Uint8Array(buffer, 4, headerLength))) as H;
  const offset = 4 + headerLength;
  const bytes = buffer.byteLength > offset ? new Uint8Array(buffer, offset) : null;
  return { header, bytes };
}

export async function startWebcamTestRecord(options: {
  deviceId: string;
  width: number;
  height: number;
  fps: number;
  mirror: boolean;
}): Promise<CameraStatus> {
  return invoke("start_webcam_test_record", options);
}

export async function stopWebcamTestRecord(): Promise<CameraStatus> {
  return invoke("stop_webcam_test_record");
}

export const credentialStorage = {
  async getItem(key: string): Promise<string | null> {
    try {
      return await withTimeout(invoke<string | null>("auth_get_item", { key }), 2500, "auth storage");
    } catch (caught) {
      console.warn("auth storage read failed", caught);
      return null;
    }
  },
  async setItem(key: string, value: string): Promise<void> {
    try {
      await invoke("auth_set_item", { key, value });
    } catch (caught) {
      throw new Error(invokeErrorMessage(caught, "Could not save the sign-in session on this PC."));
    }
  },
  async removeItem(key: string): Promise<void> {
    try {
      await invoke("auth_remove_item", { key });
    } catch (caught) {
      throw new Error(invokeErrorMessage(caught, "Could not clear the saved sign-in session."));
    }
  },
};
