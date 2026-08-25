import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { open, save } from "@tauri-apps/plugin-dialog";
import { clipShareUrl, publicAppUrl } from "../branding";
import { updateOwnClipTitle } from "../services/supabase";
import {
  deleteCloudClip,
  deleteLocalClip,
  exportLocalClip,
  listLocalClips,
  renameLocalClip,
  revealLocalClip,
  setLocalClipFavorite,
  uploadLocalClip,
} from "../services/tauri";
import type { LocalClip } from "../types/clip";
import { joinPath, suggestedFileName, uniqueFileName } from "../utils/files";
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
  error: string | null;
  initialize: () => Promise<void>;
  refresh: () => Promise<void>;
  play: (localId: string) => void;
  closePlayer: () => void;
  setFavoritesOnly: (value: boolean) => void;
  toggleSelect: (localId: string) => void;
  selectAll: (localIds: string[]) => void;
  clearSelection: () => void;
  rename: (localId: string, title: string) => Promise<void>;
  favorite: (localId: string, value: boolean) => Promise<void>;
  remove: (localId: string) => Promise<void>;
  removeMany: (localIds: string[]) => Promise<void>;
  removeFromCloud: (localId: string) => Promise<void>;
  removeFromCloudMany: (localIds: string[]) => Promise<void>;
  reveal: (filePath: string) => Promise<void>;
  upload: (localId: string) => Promise<void>;
  download: (localId: string) => Promise<void>;
  downloadMany: (localIds: string[]) => Promise<void>;
  copyLink: (localId: string) => Promise<void>;
}

let listening = false;
const uploadsInFlight = new Map<string, Promise<void>>();

function patchClip(clips: LocalClip[], next: LocalClip) {
  return clips.map((clip) => (clip.localId === next.localId ? next : clip));
}

async function deleteLinkedCloudCopy(cloudClipId: string | null | undefined) {
  if (!cloudClipId) return;
  const token = useAuthStore.getState().session?.access_token;
  if (!token) {
    useToastStore.getState().show("Sign in to delete the matching cloud copy");
    return;
  }
  await deleteCloudClip(cloudClipId, token, publicAppUrl());
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
  error: null,
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
      set({ clips, loaded: true, error: null });
    } catch (caught) {
      const message = invokeErrorMessage(caught, "Could not load clips from this PC");
      console.warn("listLocalClips failed", caught);
      useToastStore.getState().show(message);
      set({ clips: [], loaded: true, error: message });
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
  selectAll: (localIds) => set({ selectedIds: [...new Set(localIds)] }),
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
    const clip = get().clips.find((item) => item.localId === localId);
    try {
      await deleteLinkedCloudCopy(clip?.cloudClipId);
      await deleteLocalClip(localId);
      set({
        clips: get().clips.filter((item) => item.localId !== localId),
        playingId: get().playingId === localId ? null : get().playingId,
        selectedIds: get().selectedIds.filter((id) => id !== localId),
      });
      await useCloudStore.getState().refresh();
      useToastStore
        .getState()
        .show(clip?.cloudClipId ? "Clip deleted from this PC and the cloud" : "Clip deleted");
    } catch (caught) {
      useToastStore.getState().show(invokeErrorMessage(caught, "Could not delete clip"));
    }
  },
  removeMany: async (localIds) => {
    let removed = 0;
    let removedCloud = 0;
    for (const localId of localIds) {
      const clip = get().clips.find((item) => item.localId === localId);
      try {
        await deleteLinkedCloudCopy(clip?.cloudClipId);
        await deleteLocalClip(localId);
        removed += 1;
        if (clip?.cloudClipId) removedCloud += 1;
      } catch (caught) {
        useToastStore.getState().show(invokeErrorMessage(caught, "Could not delete clip"));
      }
    }
    const gone = new Set(localIds);
    const playingId = get().playingId;
    set({
      clips: get().clips.filter((clip) => !gone.has(clip.localId)),
      playingId: playingId && gone.has(playingId) ? null : playingId,
      selectedIds: get().selectedIds.filter((id) => !gone.has(id)),
    });
    await useCloudStore.getState().refresh();
    if (removed > 0) {
      useToastStore.getState().show(
        removedCloud > 0
          ? removed === 1
            ? "Clip deleted from this PC and the cloud"
            : `${removed} clips deleted from this PC and the cloud`
          : removed === 1
            ? "Clip deleted from this PC"
            : `${removed} clips deleted from this PC`,
      );
    }
  },
  removeFromCloud: async (localId) => {
    const clip = get().clips.find((item) => item.localId === localId);
    if (!clip?.cloudClipId) {
      useToastStore.getState().show("This clip is not in the cloud");
      return;
    }
    await useCloudStore.getState().unlink(clip.cloudClipId);
    await get().refresh();
  },
  removeFromCloudMany: async (localIds) => {
    const clipIds = get()
      .clips.filter((clip) => localIds.includes(clip.localId) && clip.cloudClipId)
      .map((clip) => clip.cloudClipId as string);
    if (clipIds.length === 0) {
      useToastStore.getState().show("None of the selected clips are in the cloud");
      return;
    }
    await useCloudStore.getState().unlinkMany(clipIds);
    await get().refresh();
    get().clearSelection();
  },
  reveal: async (filePath) => {
    try {
      await revealLocalClip(filePath);
    } catch (caught) {
      useToastStore.getState().show(invokeErrorMessage(caught, "Could not open that file"));
    }
  },
  upload: async (localId) => {
    const existing = uploadsInFlight.get(localId);
    if (existing) {
      await existing;
      return;
    }
    const work = (async () => {
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
      const message = invokeErrorMessage(caught, "Upload failed");
      useToastStore.getState().show(message.includes("Premium") ? `${message} Open Account to upgrade.` : message);
      await get().refresh();
    }
    })();
    uploadsInFlight.set(localId, work);
    try {
      await work;
    } finally {
      uploadsInFlight.delete(localId);
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
  downloadMany: async (localIds) => {
    const clips = get().clips.filter((clip) => localIds.includes(clip.localId));
    if (clips.length === 0) return;
    try {
      const folder = await open({
        directory: true,
        multiple: false,
        title: "Save clips to folder",
      });
      if (typeof folder !== "string" || !folder) return;
      const used = new Set<string>();
      let saved = 0;
      for (const clip of clips) {
        const ext = clip.filePath.split(".").pop() || "mp4";
        const dest = joinPath(folder, uniqueFileName(used, suggestedFileName(clip.title, "clip", ext)));
        try {
          await exportLocalClip(clip.filePath, dest);
          saved += 1;
        } catch (caught) {
          useToastStore.getState().show(invokeErrorMessage(caught, "Could not download clip"));
        }
      }
      if (saved > 0) {
        useToastStore.getState().show(saved === 1 ? "Saved to disk" : `${saved} clips saved`);
      }
      get().clearSelection();
    } catch (caught) {
      useToastStore.getState().show(invokeErrorMessage(caught, "Could not download clips"));
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
