import { invoke } from "@tauri-apps/api/core";
import type { AppSettings } from "../types/settings";
import type { LocalClip } from "../types/clip";
import type { DetectedGameSnapshot, GameCatalogEntry } from "../types/game";
import type { RecordingStatus, ReplayStatus } from "../types/recording";

export async function getAllSettings(): Promise<AppSettings> {
  return invoke("get_all_settings");
}

export async function setSetting(key: string, value: unknown): Promise<AppSettings> {
  return invoke("set_setting", { key, value });
}

export async function setSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  return invoke("set_settings", { patch });
}

export async function listLocalClips(limit = 80): Promise<LocalClip[]> {
  return invoke("list_local_clips", { limit });
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
    return invoke("auth_get_item", { key });
  },
  async setItem(key: string, value: string): Promise<void> {
    await invoke("auth_set_item", { key, value });
  },
  async removeItem(key: string): Promise<void> {
    await invoke("auth_remove_item", { key });
  },
};
