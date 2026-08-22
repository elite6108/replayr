import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { save } from "@tauri-apps/plugin-dialog";
import { clipShareUrl, publicAppUrl } from "../branding";
import { updateOwnClipTitle } from "../services/supabase";
import {
  deleteLocalClip,
  exportLocalClip,
  listLocalClips,
  renameLocalClip,
  revealLocalClip,
  setLocalClipFavorite,
  uploadLocalClip,
} from "../services/tauri";
import type { LocalClip } from "../types/clip";
import { suggestedFileName } from "../utils/files";
import { invokeErrorMessage, isVideoPath } from "../utils/format";
import { useAuthStore } from "./authStore";
import { useCloudStore } from "./cloudStore";
import { useSettingsStore } from "./settingsStore";
import { useToastStore } from "./toastStore";

interface LibraryState {
  clips: LocalClip[];
  playingId: string | null;
  favoritesOnly: boolean;
  selectedIds: string[];
  loaded: boolean;
  initialize: () => Promise<void>;
  refresh: () => Promise<void>;
  play: (localId: string) => void;
  closePlayer: () => void;
  setFavoritesOnly: (value: boolean) => void;
  toggleSelect: (localId: string) => void;
  clearSelection: () => void;
  rename: (localId: string, title: string) => Promise<void>;
  favorite: (localId: string, value: boolean) => Promise<void>;
  remove: (localId: string) => Promise<void>;
  reveal: (filePath: string) => Promise<void>;
  upload: (localId: string) => Promise<void>;
  download: (localId: string) => Promise<void>;
  copyLink: (localId: string) => Promise<void>;
}

let listening = false;

function patchClip(clips: LocalClip[], next: LocalClip) {
  return clips.map((clip) => (clip.localId === next.localId ? next : clip));
}

function shouldAutoUpload(clip: LocalClip | undefined): boolean {
  if (!clip || !isVideoPath(clip.filePath)) return false;
  if (clip.uploadStatus === "completed" || ["queued", "preparing", "uploading", "processing"].includes(clip.uploadStatus)) {
    return false;
  }
  if (!useAuthStore.getState().user) return false;
  const mode = useSettingsStore.getState().settings.autoUpload;
  if (mode === "off") return false;
  if (mode === "favorites") return clip.favorite;
  return true;
}

export const useLibraryStore = create<LibraryState>((set, get) => ({
  clips: [],
  playingId: null,
  favoritesOnly: false,
  selectedIds: [],
  loaded: false,
  initialize: async () => {
    await get().refresh();
    if (!listening) {
      listening = true;
      await listen<{ localId?: string; path: string; kind: string }>("local-clip-saved", (event) => {
        void (async () => {
          await get().refresh();
          const localId = event.payload.localId;
          if (!localId) return;
          const clip = get().clips.find((item) => item.localId === localId);
          if (shouldAutoUpload(clip)) {
            useToastStore.getState().show("Uploading to cloud…");
            await get().upload(localId);
          }
        })();
      });
      await listen("cloud-upload", () => {
        void get().refresh();
      });
    }
  },
  refresh: async () => {
    try {
      const clips = await listLocalClips(80);
      set({ clips, loaded: true });
    } catch {
      set({ clips: [], loaded: true });
    }
  },
  play: (localId) => set({ playingId: localId }),
  closePlayer: () => set({ playingId: null }),
  setFavoritesOnly: (value) => set({ favoritesOnly: value }),
  toggleSelect: (localId) => {
    const selected = get().selectedIds;
    set({
      selectedIds: selected.includes(localId) ? selected.filter((id) => id !== localId) : [...selected, localId],
    });
  },
  clearSelection: () => set({ selectedIds: [] }),
  rename: async (localId, title) => {
    try {
      const next = await renameLocalClip(localId, title);
      set({ clips: patchClip(get().clips, next) });
      const user = useAuthStore.getState().user;
      if (user && next.cloudClipId) {
        await updateOwnClipTitle(user.id, next.cloudClipId, title);
        await useCloudStore.getState().refresh();
      }
      useToastStore.getState().show("Clip renamed");
    } catch (caught) {
      useToastStore.getState().show(invokeErrorMessage(caught, "Could not rename clip"));
    }
  },
  favorite: async (localId, value) => {
    try {
      const next = await setLocalClipFavorite(localId, value);
      set({ clips: patchClip(get().clips, next) });
      if (value && shouldAutoUpload(next)) {
        void get().upload(localId);
      }
    } catch (caught) {
      useToastStore.getState().show(invokeErrorMessage(caught, "Could not update favorite"));
    }
  },
  remove: async (localId) => {
    try {
      await deleteLocalClip(localId);
      set({
        clips: get().clips.filter((clip) => clip.localId !== localId),
        playingId: get().playingId === localId ? null : get().playingId,
        selectedIds: get().selectedIds.filter((id) => id !== localId),
      });
      useToastStore.getState().show("Clip deleted");
    } catch (caught) {
      useToastStore.getState().show(invokeErrorMessage(caught, "Could not delete clip"));
    }
  },
  reveal: async (filePath) => {
    try {
      await revealLocalClip(filePath);
    } catch (caught) {
      useToastStore.getState().show(invokeErrorMessage(caught, "Could not open that file"));
    }
  },
  upload: async (localId) => {
    const token = useAuthStore.getState().session?.access_token;
    if (!token) {
      useToastStore.getState().show("Sign in to upload");
      return;
    }
    try {
      const next = await uploadLocalClip(localId, token, publicAppUrl());
      set({ clips: patchClip(get().clips, next) });
      await useCloudStore.getState().refresh();
      await useAuthStore.getState().refreshProfile();
      useToastStore.getState().show("Uploaded to cloud");
    } catch (caught) {
      useToastStore.getState().show(invokeErrorMessage(caught, "Upload failed"));
      await get().refresh();
    }
  },
  download: async (localId) => {
    const clip = get().clips.find((item) => item.localId === localId);
    if (!clip) return;
    const ext = clip.filePath.split(".").pop() || "mp4";
    try {
      const dest = await save({
        defaultPath: suggestedFileName(clip.title, "clip", ext),
        title: "Download clip",
      });
      if (!dest) return;
      await exportLocalClip(clip.filePath, dest);
      useToastStore.getState().show("Saved to disk");
    } catch (caught) {
      useToastStore.getState().show(invokeErrorMessage(caught, "Could not download clip"));
    }
  },
  copyLink: async (localId) => {
    const clip = get().clips.find((item) => item.localId === localId);
    if (!clip?.cloudClipId) {
      useToastStore.getState().show("Upload this clip to get a share link");
      return;
    }
    const cloud = useCloudStore.getState().clips.find((item) => item.id === clip.cloudClipId);
    if (!cloud) {
      await useCloudStore.getState().refresh();
    }
    const slug = useCloudStore.getState().clips.find((item) => item.id === clip.cloudClipId)?.slug;
    if (!slug) {
      useToastStore.getState().show("Could not find the cloud link yet");
      return;
    }
    try {
      await navigator.clipboard.writeText(clipShareUrl(slug));
      useToastStore.getState().show("Link copied");
    } catch {
      useToastStore.getState().show("Could not copy link");
    }
  },
}));
