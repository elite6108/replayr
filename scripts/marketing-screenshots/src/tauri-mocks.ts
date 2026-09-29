import {
  MARKETING_CAMERAS,
  MARKETING_DETECTION,
  MARKETING_DISPLAYS,
  MARKETING_LOCAL_CLIPS,
  marketingAudioStatus,
  marketingCameraStatus,
  marketingMicLevel,
  marketingRecording,
  marketingReplay,
  marketingSettings,
} from "./demo-data";

export async function invoke(cmd: string, _args?: unknown): Promise<unknown> {
  switch (cmd) {
    case "get_all_settings":
      return marketingSettings();
    case "set_setting":
    case "set_settings":
      return marketingSettings();
    case "get_default_save_location":
      return marketingSettings().saveLocation;
    case "list_local_clips":
    case "reset_stale_uploads":
      return cmd === "reset_stale_uploads" ? [] : MARKETING_LOCAL_CLIPS;
    case "get_recording_status":
      return marketingRecording();
    case "get_replay_status":
      return marketingReplay();
    case "get_audio_status":
      return marketingAudioStatus();
    case "get_mic_level":
      return marketingMicLevel();
    case "list_audio_devices":
      return [
        { id: "default", name: "Default microphone", direction: "capture", isDefault: true },
        { id: "speakers", name: "Speakers", direction: "render", isDefault: true },
      ];
    case "list_audio_sessions":
      return [];
    case "list_displays":
      return MARKETING_DISPLAYS;
    case "list_camera_devices":
      return MARKETING_CAMERAS;
    case "get_camera_status":
      return marketingCameraStatus();
    case "list_games":
    case "sync_games":
      return [];
    case "get_detected_game":
      return MARKETING_DETECTION;
    case "get_discord_presence_status":
      return null;
    case "get_hotkey_failures":
      return [];
    case "screenshot_list":
      return [];
    case "auth_get_item":
      return null;
    case "auth_set_item":
    case "auth_remove_item":
    case "create_desktop_shortcut":
    case "remove_desktop_shortcut":
    case "stop_mic_monitor":
      return null;
    case "desktop_shortcut_exists":
      return true;
    default:
      return null;
  }
}

export function convertFileSrc(path: string): string {
  if (!path) return "";
  if (path.startsWith("/") || path.startsWith("http") || path.startsWith("data:")) return path;
  const match = path.match(/clip-(\d+)\.(?:png|jpg|jpeg|webp|svg|mp4)$/i);
  if (match) return `/thumbs/clip-${match[1]}.svg`;
  return path;
}

export async function listen(_event: string, _handler: (event: { payload: unknown }) => void) {
  return () => undefined;
}

export function getCurrentWindow() {
  return {
    isMaximized: async () => true,
    onResized: async () => () => undefined,
    minimize: async () => undefined,
    toggleMaximize: async () => undefined,
    close: async () => undefined,
  };
}

export async function getVersion() {
  return "0.1.51";
}

export async function enable() {
  return undefined;
}

export async function disable() {
  return undefined;
}

export async function open() {
  return null;
}

export async function save() {
  return null;
}

export async function check() {
  return null;
}

export async function relaunch() {
  return undefined;
}

export async function openUrl() {
  return undefined;
}

export async function openPath() {
  return undefined;
}

export async function getCurrent() {
  return [];
}

export async function onOpenUrl() {
  return () => undefined;
}
