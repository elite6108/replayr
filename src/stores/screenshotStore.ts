import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import { create } from "zustand";
import { publicApiUrl } from "../branding";
import { fetchScreenshotUsage, type ScreenshotUsage } from "../services/screenshots";
import { getSupabase, supabaseConfigured } from "../services/supabase";
import {
  copyScreenshot,
  deleteScreenshot,
  exportScreenshot,
  listScreenshots,
  provideScreenshotSession,
  revealScreenshot,
  retryScreenshotUpload,
  startRegionScreenshot,
  syncScreenshotCloud,
} from "../services/tauri";
import type { Screenshot } from "../types/screenshot";
import { suggestedFileName } from "../utils/files";
import { invokeErrorMessage } from "../utils/format";
import { useAuthStore } from "./authStore";
import { useToastStore } from "./toastStore";

/**
 * Region screenshots. Kept apart from the recording store: screenshots have nothing to do with
 * Instant Replay or recording state.
 */
interface ScreenshotState {
  items: Screenshot[];
  loaded: boolean;
  usage: ScreenshotUsage | null;
  refresh: () => Promise<void>;
  refreshUsage: () => Promise<void>;
  take: () => Promise<void>;
  copy: (id: string, what: "image" | "link") => Promise<void>;
  remove: (id: string, deleteFile: boolean, deleteCloud?: boolean) => Promise<void>;
  reveal: (id: string) => Promise<void>;
  retry: (id: string) => Promise<void>;
  download: (id: string) => Promise<void>;
  syncCloud: () => Promise<void>;
}

const LISTEN_KEY = "__replayScreenshotListeners";

function upsert(items: Screenshot[], next: Screenshot): Screenshot[] {
  const rest = items.filter((item) => item.id !== next.id);
  return [next, ...rest].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export const useScreenshotStore = create<ScreenshotState>((set, get) => ({
  items: [],
  loaded: false,
  usage: null,

  refresh: async () => {
    try {
      set({ items: await listScreenshots(), loaded: true });
    } catch (caught) {
      set({ loaded: true });
      useToastStore.getState().show(invokeErrorMessage(caught, "Could not load screenshots"));
    }
  },

  refreshUsage: async () => {
    const token = useAuthStore.getState().session?.access_token;
    if (!token) {
      set({ usage: null });
      return;
    }
    try {
      set({ usage: await fetchScreenshotUsage(token) });
    } catch {
      /* usage is optional chrome; the grid still works */
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

  remove: async (id, deleteFile, deleteCloud = false) => {
    try {
      await deleteScreenshot(id, deleteFile, deleteCloud);
      if (deleteFile || !deleteCloud) {
        set((state) => ({ items: state.items.filter((item) => item.id !== id) }));
      } else {
        set((state) => ({
          items: state.items.map((item) =>
            item.id === id
              ? { ...item, cloudId: null, slug: null, shareUrl: null, uploadStatus: "local", uploadError: null }
              : item,
          ),
        }));
      }
      void useScreenshotStore.getState().refreshUsage();
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

  retry: async (id) => {
    try {
      const next = await retryScreenshotUpload(id);
      set((state) => ({ items: upsert(state.items, next) }));
      void useScreenshotStore.getState().refreshUsage();
      useToastStore.getState().show(next.shareUrl ? "Link copied" : "Uploaded");
    } catch (caught) {
      useToastStore.getState().show(invokeErrorMessage(caught, "Could not upload that screenshot"));
    }
  },

  download: async (id) => {
    const shot = get().items.find((item) => item.id === id);
    if (!shot) return;
    try {
      const dest = await save({
        defaultPath: suggestedFileName(`${shot.width}x${shot.height}`, "screenshot", "png"),
        title: "Save screenshot",
        filters: [{ name: "PNG", extensions: ["png"] }],
      });
      if (!dest) return;
      await exportScreenshot(id, dest.endsWith(".png") || dest.endsWith(".PNG") ? dest : `${dest}.png`);
      useToastStore.getState().show("Saved to disk");
    } catch (caught) {
      useToastStore.getState().show(invokeErrorMessage(caught, "Could not download that screenshot"));
    }
  },

  syncCloud: async () => {
    try {
      set({ items: await syncScreenshotCloud(), loaded: true });
    } catch (caught) {
      const message = invokeErrorMessage(caught, "");
      if (/not allowed|not found/i.test(message)) {
        await useScreenshotStore.getState().refresh();
        return;
      }
      useToastStore.getState().show(message || "Could not sync screenshots");
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
      void useScreenshotStore.getState().refreshUsage();
    }),
    await listen<Screenshot>("screenshot-updated", (event) => {
      useScreenshotStore.setState((state) => ({ items: upsert(state.items, event.payload) }));
    }),
    await listen<string>("screenshot-failed", (event) => {
      useToastStore.getState().show(event.payload || "Screenshot failed");
    }),
    await listen<{ requestId: number; forceRefresh: boolean }>("screenshot-session-request", (event) => {
      void answerScreenshotSession(event.payload.requestId, event.payload.forceRefresh);
    }),
  ];
}

async function answerScreenshotSession(requestId: number, forceRefresh: boolean): Promise<void> {
  let accessToken: string | null = null;
  try {
    if (supabaseConfigured()) {
      const supabase = getSupabase();
      const { data } = forceRefresh ? await supabase.auth.refreshSession() : await supabase.auth.getSession();
      accessToken = data.session?.access_token ?? null;
    }
  } catch {
    accessToken = null;
  }
  try {
    await provideScreenshotSession(requestId, accessToken, accessToken ? publicApiUrl() : null);
  } catch {
    try {
      await provideScreenshotSession(requestId, null, null);
    } catch {
      /* timed out on the Rust side */
    }
  }
}
