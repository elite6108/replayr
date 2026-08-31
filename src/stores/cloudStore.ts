import { open, save } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { clipShareUrl, publicApiUrl } from "../branding";
import { fetchOwnClipStatuses, fetchOwnClips, updateOwnClipTitle, updateOwnClipVisibility } from "../services/supabase";
import { deleteCloudClip, deleteLocalClip, downloadUrlToFile, listLocalClips, renameLocalClip } from "../services/tauri";
import type { CloudClip } from "../types/clip";
import { waitForCloudDownloadReady } from "../utils/cloudDownload";
import { joinPath, suggestedFileName, uniqueFileName } from "../utils/files";
import { invokeErrorMessage } from "../utils/format";
import { readApiJson } from "../utils/http";
import { useAuthStore } from "./authStore";
import { useBillingStore } from "./billingStore";
import { useToastStore } from "./toastStore";

interface CloudState {
  clips: CloudClip[];
  selectedIds: string[];
  playing: { clip: CloudClip; url: string } | null;
  loading: boolean;
  error: string | null;
  initialize: () => Promise<void>;
  refresh: () => Promise<void>;
  play: (clipId: string) => Promise<void>;
  playRemote: (clip: CloudClip, url: string) => Promise<void>;
  closePlayer: () => void;
  remove: (clipId: string) => Promise<void>;
  removeMany: (clipIds: string[]) => Promise<void>;
  unlink: (clipId: string) => Promise<void>;
  unlinkMany: (clipIds: string[]) => Promise<void>;
  rename: (clipId: string, title: string) => Promise<void>;
  setVisibility: (clipId: string, visibility: CloudClip["visibility"]) => Promise<void>;
  toggleSelect: (clipId: string) => void;
  selectAll: (clipIds: string[]) => void;
  clearSelection: () => void;
  download: (clipId: string) => Promise<void>;
  downloadMany: (clipIds: string[]) => Promise<void>;
  copyLink: (clipId: string) => Promise<void>;
}

let listening = false;

export const useCloudStore = create<CloudState>((set, get) => ({
  clips: [],
  selectedIds: [],
  playing: null,
  loading: false,
  error: null,
  initialize: async () => {
    await get().refresh();
    if (!listening) {
      listening = true;
      await listen<{ status?: string }>("cloud-upload", (event) => {
        const status = event.payload?.status;
        if (status === "completed" || status === "failed" || status === "deleted") {
          void get().refresh();
        }
      });
    }
  },
  refresh: async () => {
    const user = useAuthStore.getState().user;
    if (!user) {
      set({ clips: [], loading: false, error: null, playing: null });
      return;
    }
    set({ loading: true, error: null });
    try {
      const clips = await fetchOwnClips(user.id);
      set({ clips, loading: false, error: null });
      await reconcileDeletedCloudClips();
    } catch (caught) {
      set({
        clips: [],
        loading: false,
        error: caught instanceof Error ? caught.message : "Could not load cloud clips",
      });
    }
  },
  play: async (clipId) => {
    const token = useAuthStore.getState().session?.access_token;
    if (!token) {
      useToastStore.getState().show("Sign in to play a cloud clip");
      return;
    }
    let clip = get().clips.find((item) => item.id === clipId);
    if (!clip) {
      await get().refresh();
      clip = get().clips.find((item) => item.id === clipId);
    }
    if (!clip) {
      useToastStore.getState().show("That clip is not in your cloud library");
      return;
    }
    if (clip.status !== "ready") {
      useToastStore.getState().show("That clip is not ready to play");
      return;
    }
    try {
      const { useLibraryStore } = await import("./libraryStore");
      useLibraryStore.getState().closePlayer();
      const response = await fetch(`${publicApiUrl()}/v1/clips/${clip.slug}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const body = await readApiJson<{ playbackUrl?: string }>(response, "Could not get a playback URL");
      if (!body.playbackUrl) {
        throw new Error("Could not get a playback URL");
      }
      set({ playing: { clip, url: body.playbackUrl } });
    } catch (caught) {
      useToastStore.getState().show(invokeErrorMessage(caught, "Could not play that cloud clip"));
    }
  },
  playRemote: async (clip, url) => {
    const { useLibraryStore } = await import("./libraryStore");
    useLibraryStore.getState().closePlayer();
    set({ playing: { clip, url } });
  },
  closePlayer: () => set({ playing: null }),
  remove: async (clipId) => {
    const token = useAuthStore.getState().session?.access_token;
    if (!token) {
      useToastStore.getState().show("Sign in to delete a cloud clip");
      return;
    }
    try {
      await deleteCloudClip(clipId, token, publicApiUrl());
      set({
        clips: get().clips.filter((clip) => clip.id !== clipId),
        selectedIds: get().selectedIds.filter((id) => id !== clipId),
        playing: get().playing?.clip.id === clipId ? null : get().playing,
      });
      await useAuthStore.getState().refreshProfile();
      await deleteLocalCopiesForCloudIds([clipId]);
      useToastStore.getState().show("Clip deleted from this PC and the cloud");
    } catch (caught) {
      useToastStore.getState().show(invokeErrorMessage(caught, "Could not remove cloud clip"));
    }
  },
  removeMany: async (clipIds) => {
    const token = useAuthStore.getState().session?.access_token;
    if (!token) {
      useToastStore.getState().show("Sign in to remove cloud clips");
      return;
    }
    let removed = 0;
    for (const clipId of clipIds) {
      try {
        await deleteCloudClip(clipId, token, publicApiUrl());
        removed += 1;
      } catch (caught) {
        useToastStore.getState().show(invokeErrorMessage(caught, "Could not remove cloud clip"));
      }
    }
    const gone = new Set(clipIds);
    set({
      clips: get().clips.filter((clip) => !gone.has(clip.id)),
      selectedIds: get().selectedIds.filter((id) => !gone.has(id)),
    });
    await useAuthStore.getState().refreshProfile();
    await deleteLocalCopiesForCloudIds(clipIds);
    if (removed > 0) {
      useToastStore
        .getState()
        .show(
          removed === 1
            ? "Clip deleted from this PC and the cloud"
            : `${removed} clips deleted from this PC and the cloud`,
        );
    }
  },
  unlink: async (clipId) => {
    const token = useAuthStore.getState().session?.access_token;
    if (!token) {
      useToastStore.getState().show("Sign in to delete a cloud clip");
      return;
    }
    try {
      await deleteCloudClip(clipId, token, publicApiUrl());
      set({
        clips: get().clips.filter((clip) => clip.id !== clipId),
        selectedIds: get().selectedIds.filter((id) => id !== clipId),
      });
      await useAuthStore.getState().refreshProfile();
      const { useLibraryStore } = await import("./libraryStore");
      await useLibraryStore.getState().refresh();
      useToastStore.getState().show("Removed from cloud. The file on this PC is unchanged.");
    } catch (caught) {
      useToastStore.getState().show(invokeErrorMessage(caught, "Could not remove cloud clip"));
    }
  },
  unlinkMany: async (clipIds) => {
    const token = useAuthStore.getState().session?.access_token;
    if (!token) {
      useToastStore.getState().show("Sign in to remove cloud clips");
      return;
    }
    let removed = 0;
    for (const clipId of clipIds) {
      try {
        await deleteCloudClip(clipId, token, publicApiUrl());
        removed += 1;
      } catch (caught) {
        useToastStore.getState().show(invokeErrorMessage(caught, "Could not remove cloud clip"));
      }
    }
    const gone = new Set(clipIds);
    set({
      clips: get().clips.filter((clip) => !gone.has(clip.id)),
      selectedIds: get().selectedIds.filter((id) => !gone.has(id)),
    });
    await useAuthStore.getState().refreshProfile();
    const { useLibraryStore } = await import("./libraryStore");
    await useLibraryStore.getState().refresh();
    if (removed > 0) {
      useToastStore
        .getState()
        .show(
          removed === 1
            ? "Removed from cloud. The file on this PC is unchanged."
            : `${removed} cloud copies removed. Files on this PC are unchanged.`,
        );
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
  setVisibility: async (clipId, visibility) => {
    const user = useAuthStore.getState().user;
    if (!user) {
      useToastStore.getState().show("Sign in to change visibility");
      return;
    }
    try {
      await updateOwnClipVisibility(user.id, clipId, visibility);
      set({
        clips: get().clips.map((clip) => (clip.id === clipId ? { ...clip, visibility } : clip)),
        playing:
          get().playing?.clip.id === clipId && get().playing
            ? { ...get().playing!, clip: { ...get().playing!.clip, visibility } }
            : get().playing,
      });
      useToastStore.getState().show(
        visibility === "private"
          ? "Private — only you can watch"
          : visibility === "unlisted"
            ? "Unlisted — anyone with the link can watch"
            : "Public — listed for everyone",
      );
    } catch (caught) {
      useToastStore.getState().show(invokeErrorMessage(caught, "Could not change visibility"));
    }
  },
  toggleSelect: (clipId) => {
    const selected = get().selectedIds;
    set({
      selectedIds: selected.includes(clipId) ? selected.filter((id) => id !== clipId) : [...selected, clipId],
    });
  },
  selectAll: (clipIds) => set({ selectedIds: [...new Set(clipIds)] }),
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
      const downloadUrl = `${publicApiUrl()}/v1/clips/${clip.slug}/download`;
      const dest = await save({
        defaultPath: suggestedFileName(clip.title, "clip", "mp4"),
        title: "Download cloud clip",
      });
      if (!dest) return;
      const freeTier = useBillingStore.getState().status?.watermark !== false;
      const upgradeHint = freeTier
        ? " Upgrade to Premium for instant downloads without watermarks."
        : "";
      useToastStore.getState().show(`Download will begin within about 30 seconds…${upgradeHint}`);
      await waitForCloudDownloadReady(downloadUrl, token, {
        onProgress: (update) => {
          if (update.attempt === 1 || update.attempt % 3 === 0 || update.progress >= 1) {
            useToastStore.getState().show(
              update.progress >= 1
                ? "Starting download…"
                : `${update.message}${upgradeHint}`,
            );
          }
        },
      });
      await downloadUrlToFile(downloadUrl, dest, { skipWatermark: true, accessToken: token });
      useToastStore.getState().show("Saved to disk");
    } catch (caught) {
      useToastStore.getState().show(invokeErrorMessage(caught, "Could not download clip"));
    }
  },
  downloadMany: async (clipIds) => {
    const token = useAuthStore.getState().session?.access_token;
    const clips = get().clips.filter((clip) => clipIds.includes(clip.id) && clip.status === "ready");
    if (!token) {
      useToastStore.getState().show("Sign in to download cloud clips");
      return;
    }
    if (clips.length === 0) {
      useToastStore.getState().show("None of the selected clips are ready to download");
      return;
    }
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
        try {
          const downloadUrl = `${publicApiUrl()}/v1/clips/${clip.slug}/download`;
          const dest = joinPath(folder, uniqueFileName(used, suggestedFileName(clip.title, "clip", "mp4")));
          await waitForCloudDownloadReady(downloadUrl, token);
          await downloadUrlToFile(downloadUrl, dest, { skipWatermark: true, accessToken: token });
          saved += 1;
        } catch {
          /* continue remaining clips */
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
  copyLink: async (clipId) => {
    const clip = get().clips.find((item) => item.id === clipId);
    if (!clip) return;
    if (clip.visibility === "private") {
      useToastStore.getState().show("Private clips have no share link. Set Unlisted or Public first.");
      return;
    }
    try {
      await navigator.clipboard.writeText(clipShareUrl(clip.slug));
      useToastStore.getState().show(
        clip.visibility === "public" ? "Public link copied" : "Unlisted link copied",
      );
    } catch {
      useToastStore.getState().show("Could not copy link");
    }
  },
}));

async function deleteLocalCopiesForCloudIds(clipIds: string[]) {
  const { useLibraryStore } = await import("./libraryStore");
  const locals = useLibraryStore
    .getState()
    .clips.filter((clip) => clip.cloudClipId && clipIds.includes(clip.cloudClipId));
  for (const clip of locals) {
    try {
      await deleteLocalClip(clip.localId);
    } catch {
      /* local file may already be gone */
    }
  }
  await useLibraryStore.getState().refresh();
}

async function reconcileDeletedCloudClips() {
  const user = useAuthStore.getState().user;
  if (!user) return;
  let locals;
  try {
    locals = (await listLocalClips(2000)).filter((clip) => clip.cloudClipId);
  } catch {
    return;
  }
  if (locals.length === 0) return;
  try {
    const statuses = await fetchOwnClipStatuses(
      user.id,
      locals.map((clip) => clip.cloudClipId as string),
    );
    let removed = 0;
    for (const clip of locals) {
      const status = statuses.get(clip.cloudClipId as string);
      if (status && status !== "deleted") continue;
      try {
        await deleteLocalClip(clip.localId);
        removed += 1;
      } catch {
        /* keep going */
      }
    }
    if (removed > 0) {
      const { useLibraryStore } = await import("./libraryStore");
      await useLibraryStore.getState().refresh();
    }
  } catch {
    /* a failed status check must not delete local files */
  }
}
