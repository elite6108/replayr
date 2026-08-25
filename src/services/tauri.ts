import { invoke } from "@tauri-apps/api/core";
import type { AppSettings } from "../types/settings";
import type { AudioDevice, AudioEngineStatus, AudioSession } from "../types/audio";
import type { LocalClip } from "../types/clip";
import type { DetectedGameSnapshot, GameCatalogEntry } from "../types/game";
import type { RecordingStatus, ReplayStatus } from "../types/recording";
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

export async function shareLocalClip(filePath: string): Promise<string> {
  return invoke("share_local_clip", { filePath });
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

export async function renameLocalClip(localId: string, title: string): Promise<LocalClip> {
  return invoke("rename_local_clip", { localId, title });
}

export async function setLocalClipFavorite(localId: string, favorite: boolean): Promise<LocalClip> {
  return invoke("set_local_clip_favorite", { localId, favorite });
}

export async function deleteLocalClip(localId: string): Promise<void> {
  return invoke("delete_local_clip", { localId });
}

export async function revealLocalClip(filePath: string): Promise<void> {
  return invoke("reveal_local_clip", { filePath });
}

export async function exportLocalClip(source: string, dest: string): Promise<void> {
  return invoke("export_local_clip", { source, dest });
}

export async function downloadUrlToFile(url: string, dest: string): Promise<void> {
  return invoke("download_url_to_file", { url, dest });
}

export async function uploadLocalClip(localId: string, accessToken: string, apiBase: string): Promise<LocalClip> {
  return invoke("upload_local_clip", { localId, accessToken, apiBase });
}

export async function deleteCloudClip(clipId: string, accessToken: string, apiBase: string): Promise<void> {
  return invoke("delete_cloud_clip", { clipId, accessToken, apiBase });
}

export async function getDefaultSaveLocation(): Promise<string> {
  return invoke("get_default_save_location");
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

export async function startRecording(): Promise<RecordingStatus> {
  return invoke("start_recording");
}

export async function stopRecording(): Promise<RecordingStatus> {
  return invoke("stop_recording");
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
