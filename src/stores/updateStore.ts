import { getVersion } from "@tauri-apps/api/app";
import { check as checkUpdate, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { create } from "zustand";
import { invokeErrorMessage } from "../utils/format";
import { useRecordingStore } from "./recordingStore";
import { useSettingsStore } from "./settingsStore";

export type UpdateStatus = "idle" | "checking" | "up-to-date" | "ready" | "downloading" | "error";

const AUTO_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

let pending: Update | null = null;
let installInFlight = false;
let autoCheckTimer: number | null = null;

export function shouldAutoInstall(input: {
  enabled: boolean;
  settingsLoaded: boolean;
  updateReady: boolean;
  recordingActive: boolean;
  savingClip: boolean;
  installInFlight: boolean;
}): boolean {
  return (
    input.enabled &&
    input.settingsLoaded &&
    input.updateReady &&
    !input.recordingActive &&
    !input.savingClip &&
    !input.installInFlight
  );
}

interface UpdateState {
  version: string;
  status: UpdateStatus;
  availableVersion: string | null;
  notes: string | null;
  downloadPercent: number | null;
  error: string | null;
  initialize: () => Promise<void>;
  check: () => Promise<void>;
  installAndRelaunch: () => Promise<void>;
}

export const useUpdateStore = create<UpdateState>((set, get) => ({
  version: "",
  status: "idle",
  availableVersion: null,
  notes: null,
  downloadPercent: null,
  error: null,
  initialize: async () => {
    try {
      set({ version: await getVersion() });
    } catch {
      // Keep an empty version if the shell is not available.
    }
    window.setTimeout(() => {
      void get().check();
    }, 1500);
  },
  check: async () => {
    if (get().status === "checking" || get().status === "downloading" || installInFlight) return;
    set({ status: "checking", error: null, downloadPercent: null });
    try {
      const update = await checkUpdate();
      if (update) {
        pending = update;
        set({
          status: "ready",
          availableVersion: update.version,
          notes: update.body ?? null,
          error: null,
        });
        queueAutoInstall();
        return;
      }
      pending = null;
      set({ status: "up-to-date", availableVersion: null, notes: null, error: null });
    } catch (caught) {
      pending = null;
      set({ status: "error", error: invokeErrorMessage(caught, "Could not check for updates.") });
    }
  },
  installAndRelaunch: async () => {
    if (installInFlight) return;
    const update = pending;
    if (!update) {
      set({ status: "error", error: "No update is ready to install." });
      return;
    }
    installInFlight = true;
    set({ status: "downloading", downloadPercent: 0, error: null });
    try {
      let downloaded = 0;
      let total = 0;
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? 0;
          set({ status: "downloading", downloadPercent: total ? 0 : null });
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          set({
            status: "downloading",
            downloadPercent: total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : null,
          });
        } else if (event.event === "Finished") {
          set({ status: "downloading", downloadPercent: 100 });
        }
      });
      await relaunch();
    } catch (caught) {
      installInFlight = false;
      set({
        status: "error",
        error: invokeErrorMessage(caught, "Could not install the update."),
        downloadPercent: null,
      });
    }
  },
}));

function queueAutoInstall() {
  const settingsState = useSettingsStore.getState();
  const recording = useRecordingStore.getState();
  const updateState = useUpdateStore.getState();
  if (
    !shouldAutoInstall({
      enabled: settingsState.settings.autoInstallUpdates,
      settingsLoaded: settingsState.loaded,
      updateReady: updateState.status === "ready" && pending != null,
      recordingActive: recording.status.active,
      savingClip: recording.replay.saving,
      installInFlight,
    })
  ) {
    return;
  }
  void updateState.installAndRelaunch();
}

function syncAutoCheckTimer() {
  const { loaded, settings } = useSettingsStore.getState();
  if (!loaded || !settings.autoInstallUpdates) {
    if (autoCheckTimer != null) {
      window.clearInterval(autoCheckTimer);
      autoCheckTimer = null;
    }
    return;
  }
  if (autoCheckTimer != null) return;
  autoCheckTimer = window.setInterval(() => {
    const status = useUpdateStore.getState().status;
    if (status === "checking" || status === "downloading" || installInFlight) return;
    void useUpdateStore.getState().check();
  }, AUTO_CHECK_INTERVAL_MS);
}

useSettingsStore.subscribe((state, previous) => {
  syncAutoCheckTimer();
  const enabledNow = state.loaded && state.settings.autoInstallUpdates;
  const enabledBefore = previous.loaded && previous.settings.autoInstallUpdates;
  if (enabledNow && !enabledBefore) queueAutoInstall();
});

useRecordingStore.subscribe((state, previous) => {
  const wasBlocked = previous.status.active || previous.replay.saving;
  const blocked = state.status.active || state.replay.saving;
  if (wasBlocked && !blocked) queueAutoInstall();
});
