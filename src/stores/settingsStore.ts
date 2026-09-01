import { create } from "zustand";
import type { AppSettings, CloudUploadWhen } from "../types/settings";
import { DEFAULT_SETTINGS } from "../types/settings";
import { sanitizeRecordingVisuals } from "../recording/visualFilters";
import { createDesktopShortcut, getAllSettings, getDefaultSaveLocation, removeDesktopShortcut, setSetting, setSettings } from "../services/tauri";
import { enable as enableAutostart, disable as disableAutostart } from "@tauri-apps/plugin-autostart";

interface SettingsState {
  settings: AppSettings;
  loaded: boolean;
  load: () => Promise<void>;
  update: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => Promise<void>;
  patch: (values: Partial<AppSettings>) => Promise<void>;
}

async function syncLaunchAtStartup(enabled: boolean) {
  if (enabled) await enableAutostart();
  else await disableAutostart();
}

async function syncDesktopShortcut(enabled: boolean) {
  if (enabled) await createDesktopShortcut();
  else await removeDesktopShortcut();
}

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

function persistOnboardingCompleted(value: boolean) {
  try {
    localStorage.setItem("replay.onboardingCompleted", value ? "1" : "0");
  } catch {
    /* private mode */
  }
}

function resolveCloudUploadWhen(settings: AppSettings): CloudUploadWhen {
  if (settings.cloudUploadWhen === "immediate" || settings.cloudUploadWhen === "afterGame") {
    return settings.cloudUploadWhen;
  }
  return settings.pauseUploadsWhileGaming === false ? "immediate" : "afterGame";
}

function normalizeSettings(settings: AppSettings): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...settings,
    cloudUploadWhen: resolveCloudUploadWhen(settings),
    micGain: typeof settings.micGain === "number" ? settings.micGain : DEFAULT_SETTINGS.micGain,
    gameAudioEnabled: settings.gameAudioEnabled ?? DEFAULT_SETTINGS.gameAudioEnabled,
    gameAudioGain: typeof settings.gameAudioGain === "number" ? settings.gameAudioGain : DEFAULT_SETTINGS.gameAudioGain,
    discordAudioEnabled: settings.discordAudioEnabled ?? DEFAULT_SETTINGS.discordAudioEnabled,
    discordAudioGain: typeof settings.discordAudioGain === "number" ? settings.discordAudioGain : DEFAULT_SETTINGS.discordAudioGain,
    extraApps: Array.isArray(settings.extraApps) ? settings.extraApps : DEFAULT_SETTINGS.extraApps,
    hotkeys: { ...DEFAULT_SETTINGS.hotkeys, ...settings.hotkeys },
    watermarkExports: settings.watermarkExports ?? DEFAULT_SETTINGS.watermarkExports,
    clipSavedNotification: settings.clipSavedNotification ?? DEFAULT_SETTINGS.clipSavedNotification,
    discordRichPresence: settings.discordRichPresence ?? DEFAULT_SETTINGS.discordRichPresence,
    webcam: {
      ...DEFAULT_SETTINGS.webcam,
      ...(settings.webcam ?? {}),
      enabled: settings.webcam?.enabled ?? false,
      mirrorPreview: settings.webcam?.mirrorPreview ?? true,
      mirrorRecording: settings.webcam?.mirrorRecording ?? false,
    },
    recordingVisuals: sanitizeRecordingVisuals(settings.recordingVisuals),
  };
}

async function reloadSettings(): Promise<AppSettings | null> {
  try {
    return normalizeSettings(await getAllSettings());
  } catch (caught) {
    console.warn("settings reload failed", caught);
    return null;
  }
}

export const useSettingsStore = create<SettingsState>((set) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,
  load: async () => {
    try {
      const incoming = await getAllSettings();
      let settings = normalizeSettings(incoming);
      if (!settings.saveLocation) {
        try {
          const saveLocation = await withTimeout(getDefaultSaveLocation(), 3000, "save location");
          settings = await withTimeout(setSetting("saveLocation", saveLocation), 4000, "save location write");
        } catch {
          // Keep defaults even if the first write fails.
        }
      }
      if (
        incoming.cloudUploadWhen !== "immediate" &&
        incoming.cloudUploadWhen !== "afterGame" &&
        settings.cloudUploadWhen
      ) {
        try {
          settings = await withTimeout(
            setSetting("cloudUploadWhen", settings.cloudUploadWhen),
            4000,
            "cloud upload when write",
          );
        } catch {
          // Keep the migrated in-memory value if the first write fails.
        }
      }
      if (settings.autoUpload === "off" && localStorage.getItem("replay.autoUploadWired") !== "1") {
        try {
          settings = await withTimeout(setSetting("autoUpload", "all"), 4000, "auto-upload write");
        } catch {
          settings = { ...settings, autoUpload: "all" };
        }
        localStorage.setItem("replay.autoUploadWired", "1");
      } else {
        localStorage.setItem("replay.autoUploadWired", "1");
      }
      persistOnboardingCompleted(settings.onboardingCompleted);
      set({ settings, loaded: true });
    } catch (caught) {
      console.warn("settings load failed; using defaults", caught);
      let cachedDone = false;
      try {
        cachedDone = localStorage.getItem("replay.onboardingCompleted") === "1";
      } catch {
        cachedDone = false;
      }
      persistOnboardingCompleted(cachedDone);
      set({ settings: { ...DEFAULT_SETTINGS, onboardingCompleted: cachedDone }, loaded: true });
    }
  },
  update: async (key, value) => {
    set((state) => ({ settings: { ...state.settings, [key]: value } }));
    if (key === "onboardingCompleted") persistOnboardingCompleted(Boolean(value));
    try {
      const settings = normalizeSettings(await setSetting(key, value));
      if (key === "launchAtStartup") await syncLaunchAtStartup(Boolean(value));
      if (key === "desktopShortcut") await syncDesktopShortcut(Boolean(value));
      set({ settings });
    } catch (caught) {
      console.warn("settings update failed", key, caught);
      const restored = await reloadSettings();
      if (restored) set({ settings: restored });
      throw caught;
    }
  },
  patch: async (values) => {
    set((state) => ({ settings: { ...state.settings, ...values } }));
    try {
      const settings = normalizeSettings(await setSettings(values));
      if (Object.prototype.hasOwnProperty.call(values, "launchAtStartup")) {
        await syncLaunchAtStartup(settings.launchAtStartup);
      }
      if (Object.prototype.hasOwnProperty.call(values, "desktopShortcut")) {
        await syncDesktopShortcut(settings.desktopShortcut);
      }
      if (Object.prototype.hasOwnProperty.call(values, "onboardingCompleted")) {
        persistOnboardingCompleted(settings.onboardingCompleted);
      }
      set({ settings });
    } catch (caught) {
      console.warn("settings patch failed", caught);
      const restored = await reloadSettings();
      if (restored) set({ settings: restored });
      throw caught;
    }
  },
}));
