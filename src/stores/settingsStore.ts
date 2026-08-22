import { create } from "zustand";
import type { AppSettings } from "../types/settings";
import { DEFAULT_SETTINGS } from "../types/settings";
import { getAllSettings, getDefaultSaveLocation, setSetting, setSettings } from "../services/tauri";
import { enable as enableAutostart, disable as disableAutostart } from "@tauri-apps/plugin-autostart";

interface SettingsState {
  settings: AppSettings;
  loaded: boolean;
  load: () => Promise<void>;
  update: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => Promise<void>;
  patch: (values: Partial<AppSettings>) => Promise<void>;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,
  load: async () => {
    let settings = await getAllSettings();
    if (!settings.saveLocation) {
      const saveLocation = await getDefaultSaveLocation();
      settings = await setSetting("saveLocation", saveLocation);
    }
    if (settings.autoUpload === "off" && localStorage.getItem("replay.autoUploadWired") !== "1") {
      settings = await setSetting("autoUpload", "all");
      localStorage.setItem("replay.autoUploadWired", "1");
    } else {
      localStorage.setItem("replay.autoUploadWired", "1");
    }
    set({ settings, loaded: true });
  },
  update: async (key, value) => {
    const settings = await setSetting(key, value);
    if (key === "launchAtStartup") {
      if (value) await enableAutostart();
      else await disableAutostart();
    }
    set({ settings });
  },
  patch: async (values) => {
    const settings = await setSettings(values);
    if (Object.prototype.hasOwnProperty.call(values, "launchAtStartup")) {
      if (settings.launchAtStartup) await enableAutostart();
      else await disableAutostart();
    }
    set({ settings });
  },
}));
