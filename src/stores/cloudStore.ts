import { save } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { clipShareUrl, publicAppUrl } from "../branding";
import { fetchOwnClips, updateOwnClipTitle } from "../services/supabase";
import { deleteCloudClip, downloadUrlToFile, renameLocalClip } from "../services/tauri";
import type { CloudClip } from "../types/clip";
import { suggestedFileName } from "../utils/files";
import { invokeErrorMessage } from "../utils/format";
import { useAuthStore } from "./authStore";
import { useToastStore } from "./toastStore";

interface CloudState {
  clips: CloudClip[];
  selectedIds: string[];
  loading: boolean;
  error: string | null;
  initialize: () => Promise<void>;
  refresh: () => Promise<void>;
  remove: (clipId: string) => Promise<void>;
  rename: (clipId: string, title: string) => Promise<void>;
  toggleSelect: (clipId: string) => void;
  clearSelection: () => void;
  download: (clipId: string) => Promise<void>;
  copyLink: (clipId: string) => Promise<void>;
}

let listening = false;

export const useCloudStore = create<CloudState>((set, get) => ({
  clips: [],
  selectedIds: [],
  loading: false,
  error: null,
  initialize: async () => {
    await get().refresh();
    if (!listening) {
      listening = true;
      await listen("cloud-upload", () => {
        void get().refresh();
      });
    }
  },
  refresh: async () => {
    const user = useAuthStore.getState().user;
    if (!user) {
      set({ clips: [], loading: false, error: null });
      return;
    }
    set({ loading: true, error: null });
    try {
      const clips = await fetchOwnClips(user.id);
      set({ clips, loading: false, error: null });
    } catch (caught) {
      set({
        clips: [],
        loading: false,
        error: caught instanceof Error ? caught.message : "Could not load cloud clips",
      });
    }
  },
  remove: async (clipId) => {
    const token = useAuthStore.getState().session?.access_token;
    if (!token) {
      useToastStore.getState().show("Sign in to delete a cloud clip");
      return;
    }
    try {
      await deleteCloudClip(clipId, token, publicAppUrl());
      set({
        clips: get().clips.filter((clip) => clip.id !== clipId),
        selectedIds: get().selectedIds.filter((id) => id !== clipId),
      });
      await useAuthStore.getState().refreshProfile();
      useToastStore.getState().show("Cloud clip deleted. The file on this PC is unchanged.");
    } catch (caught) {
      useToastStore.getState().show(invokeErrorMessage(caught, "Could not delete cloud clip"));
    }
  },
  rename: async (clipId, title) => {
    const user = useAuthStore.getState().user;
    if (!user) {
      useToastStore.getState().show("Sign in to rename a cloud clip");
      return;
    }
    try {
      await updateOwnClipTitle(user.id, clipId, title);
      const nextTitle = title.trim();
      set({
        clips: get().clips.map((clip) => (clip.id === clipId ? { ...clip, title: nextTitle } : clip)),
      });
      const { useLibraryStore } = await import("./libraryStore");
      const local = useLibraryStore.getState().clips.find((clip) => clip.cloudClipId === clipId);
      if (local) {
        try {
          const next = await renameLocalClip(local.localId, nextTitle);
          useLibraryStore.setState({
            clips: useLibraryStore.getState().clips.map((clip) => (clip.localId === next.localId ? next : clip)),
          });
        } catch {
          // Cloud title already saved; local copy can stay stale.
        }
      }
      useToastStore.getState().show("Cloud clip renamed");
    } catch (caught) {
      useToastStore.getState().show(invokeErrorMessage(caught, "Could not rename clip"));
    }
  },
  toggleSelect: (clipId) => {
    const selected = get().selectedIds;
    set({
      selectedIds: selected.includes(clipId) ? selected.filter((id) => id !== clipId) : [...selected, clipId],
    });
  },
  clearSelection: () => set({ selectedIds: [] }),
  download: async (clipId) => {
    const clip = get().clips.find((item) => item.id === clipId);
    const token = useAuthStore.getState().session?.access_token;
    if (!clip || !token) {
      useToastStore.getState().show("Sign in to download a cloud clip");
      return;
    }
    if (clip.status !== "ready") {
      useToastStore.getState().show("That clip is not ready to download");
      return;
    }
    try {
      const response = await fetch(`${publicAppUrl()}/v1/clips/${clip.slug}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const body = (await response.json()) as { playbackUrl?: string; error?: string };
      if (!response.ok || !body.playbackUrl) {
        throw new Error(body.error || "Could not get a download URL");
      }
      const dest = await save({
        defaultPath: suggestedFileName(clip.title, "clip", "mp4"),
        title: "Download cloud clip",
      });
      if (!dest) return;
      await downloadUrlToFile(body.playbackUrl, dest);
      useToastStore.getState().show("Saved to disk");
    } catch (caught) {
      useToastStore.getState().show(invokeErrorMessage(caught, "Could not download clip"));
    }
  },
  copyLink: async (clipId) => {
    const clip = get().clips.find((item) => item.id === clipId);
    if (!clip) return;
    try {
      await navigator.clipboard.writeText(clipShareUrl(clip.slug));
      useToastStore.getState().show("Link copied");
    } catch {
      useToastStore.getState().show("Could not copy link");
    }
  },
}));
