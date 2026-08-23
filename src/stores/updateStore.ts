import { getVersion } from "@tauri-apps/api/app";
import { check as checkUpdate, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { create } from "zustand";
import { invokeErrorMessage } from "../utils/format";

export type UpdateStatus = "idle" | "checking" | "up-to-date" | "ready" | "downloading" | "error";

let pending: Update | null = null;

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
    const update = pending;
    if (!update) {
      set({ status: "error", error: "No update is ready to install." });
      return;
    }
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
      set({
        status: "error",
        error: invokeErrorMessage(caught, "Could not install the update."),
        downloadPercent: null,
      });
    }
  },
}));
