import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import {
  copyScreenshot,
  deleteScreenshot,
  listScreenshots,
  revealScreenshot,
  startRegionScreenshot,
} from "../services/tauri";
import type { Screenshot } from "../types/screenshot";
import { invokeErrorMessage } from "../utils/format";
import { useToastStore } from "./toastStore";

/**
 * Region screenshots. Kept apart from the recording store: screenshots have nothing to do with
 * Instant Replay or recording state.
 */
interface ScreenshotState {
  items: Screenshot[];
  loaded: boolean;
  refresh: () => Promise<void>;
  take: () => Promise<void>;
  copy: (id: string, what: "image" | "link") => Promise<void>;
  remove: (id: string, deleteFile: boolean) => Promise<void>;
  reveal: (id: string) => Promise<void>;
}

const LISTEN_KEY = "__replayScreenshotListeners";

function upsert(items: Screenshot[], next: Screenshot): Screenshot[] {
  const rest = items.filter((item) => item.id !== next.id);
  return [next, ...rest].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export const useScreenshotStore = create<ScreenshotState>((set) => ({
  items: [],
  loaded: false,

  refresh: async () => {
    try {
      set({ items: await listScreenshots(), loaded: true });
    } catch (caught) {
      set({ loaded: true });
      useToastStore.getState().show(invokeErrorMessage(caught, "Could not load screenshots"));
    }
  },

  take: async () => {
    try {
      await startRegionScreenshot();
    } catch (caught) {
      useToastStore.getState().show(invokeErrorMessage(caught, "Could not start a screenshot"));
    }
  },

  copy: async (id, what) => {
    try {
      await copyScreenshot(id, what);
      useToastStore.getState().show(what === "link" ? "Link copied" : "Screenshot copied");
    } catch (caught) {
      useToastStore.getState().show(invokeErrorMessage(caught, "Could not copy"));
    }
  },

  remove: async (id, deleteFile) => {
    try {
      await deleteScreenshot(id, deleteFile);
      set((state) => ({ items: state.items.filter((item) => item.id !== id) }));
    } catch (caught) {
      useToastStore.getState().show(invokeErrorMessage(caught, "Could not delete that screenshot"));
    }
  },

  reveal: async (id) => {
    try {
      await revealScreenshot(id);
    } catch (caught) {
      useToastStore.getState().show(invokeErrorMessage(caught, "Could not show that file"));
    }
  },
}));

/**
 * Keep the store in step with screenshots taken by hotkey or tray while the app is open.
 * Idempotent across hot reloads: previous listeners are detached first.
 */
export async function attachScreenshotListeners(): Promise<void> {
  const slot = window as unknown as Record<string, Array<() => void> | undefined>;
  for (const off of slot[LISTEN_KEY] ?? []) off();
  slot[LISTEN_KEY] = [
    await listen<Screenshot>("screenshot-saved", (event) => {
      useScreenshotStore.setState((state) => ({ items: upsert(state.items, event.payload) }));
    }),
    await listen<Screenshot>("screenshot-updated", (event) => {
      useScreenshotStore.setState((state) => ({ items: upsert(state.items, event.payload) }));
    }),
    await listen<string>("screenshot-failed", (event) => {
      useToastStore.getState().show(event.payload || "Screenshot failed");
    }),
  ];
}
