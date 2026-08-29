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
  resetStaleUploads,
  revealLocalClip,
  setLocalClipFavorite,
  uploadLocalClip,
} from "../services/tauri";
import { shouldAutoUpload, shouldDeferUpload } from "../services/cloudUploadPolicy";
import type { LocalClip } from "../types/clip";
import type { CloudUploadEvent, UploadQueueItem, UploadQueuePhase } from "../types/upload";
import { isUploadQueuePhase } from "../types/upload";
import { joinPath, suggestedFileName, uniqueFileName } from "../utils/files";
import { invokeErrorMessage, isVideoPath } from "../utils/format";
import { useAuthStore } from "./authStore";
import { useCloudStore } from "./cloudStore";
import { useDetectionStore } from "./detectionStore";
import { useRecordingStore } from "./recordingStore";
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
  uploadQueue: UploadQueueItem[];
  activeUploadId: string | null;
  upload: (localId: string) => Promise<void>;
  ensureCloudUpload: (localId: string) => Promise<boolean>;
  dequeueUpload: (localId: string) => void;
  download: (localId: string) => Promise<void>;
  downloadMany: (localIds: string[]) => Promise<void>;
  copyLink: (localId: string) => Promise<void>;
}

let listening = false;
const uploadsInFlight = new Map<string, Promise<void>>();
const jobResolvers = new Map<string, { resolve: () => void; reject: (reason?: unknown) => void }>();
const pendingOrder: string[] = [];
const pendingAutoUploads = new Set<string>();
const cancelledUploads = new Set<string>();
let deferToastShown = false;
let drainRunning = false;

function patchClip(clips: LocalClip[], next: LocalClip) {
  return clips.map((clip) => (clip.localId === next.localId ? next : clip));
}

function clipTitle(clip: LocalClip | undefined): string {
  const title = clip?.title?.trim();
  return title || "Clip";
}

function queueItem(localId: string, clip: LocalClip | undefined, phase: UploadQueuePhase): UploadQueueItem {
  return {
    localId,
    title: clipTitle(clip),
    phase,
    bytesUploaded: 0,
    bytesTotal: clip?.fileSize ?? 0,
    startedAt: null,
  };
}

function markQueued(localId: string) {
  const state = useLibraryStore.getState();
  if (state.uploadQueue.some((item) => item.localId === localId)) return;
  const clip = state.clips.find((item) => item.localId === localId);
  const nextClip =
    clip && clip.uploadStatus === "local"
      ? { ...clip, uploadStatus: "queued" as const }
      : clip;
  useLibraryStore.setState({
    uploadQueue: [...state.uploadQueue, queueItem(localId, clip, "queued")],
    clips: nextClip ? patchClip(state.clips, nextClip) : state.clips,
  });
}

function removeQueueItem(localId: string) {
  const state = useLibraryStore.getState();
  useLibraryStore.setState({
    uploadQueue: state.uploadQueue.filter((item) => item.localId !== localId),
    activeUploadId: state.activeUploadId === localId ? null : state.activeUploadId,
  });
}

function patchQueueItem(localId: string, patch: Partial<UploadQueueItem>) {
  const state = useLibraryStore.getState();
  useLibraryStore.setState({
    uploadQueue: state.uploadQueue.map((item) => (item.localId === localId ? { ...item, ...patch } : item)),
  });
}

function applyUploadEvent(payload: CloudUploadEvent) {
  const localId = payload.localId;
  if (!localId) return;
  const status = payload.status || payload.phase;
  if (status === "deleted") {
    removeQueueItem(localId);
    return;
  }
  if (status === "completed" || status === "failed") {
    removeQueueItem(localId);
    void useLibraryStore.getState().refresh();
    if (status === "completed") {
      void useCloudStore.getState().refresh();
    }
    return;
  }
  if (!isUploadQueuePhase(status)) return;
  const state = useLibraryStore.getState();
  const clip = state.clips.find((item) => item.localId === localId);
  const existing = state.uploadQueue.find((item) => item.localId === localId);
  const bytesUploaded = typeof payload.bytesUploaded === "number" ? payload.bytesUploaded : existing?.bytesUploaded ?? 0;
  const bytesTotal = typeof payload.bytesTotal === "number" ? payload.bytesTotal : existing?.bytesTotal ?? clip?.fileSize ?? 0;
  const startedAt =
    status === "uploading" ? existing?.startedAt ?? Date.now() : status === "preparing" ? null : existing?.startedAt ?? null;
  const nextItem: UploadQueueItem = {
    localId,
    title: existing?.title || clipTitle(clip),
    phase: status,
    bytesUploaded,
    bytesTotal,
    startedAt,
  };
  useLibraryStore.setState({
    uploadQueue: existing
      ? state.uploadQueue.map((item) => (item.localId === localId ? nextItem : item))
      : [...state.uploadQueue, nextItem],
    activeUploadId: status === "queued" ? state.activeUploadId : localId,
    clips: clip ? patchClip(state.clips, { ...clip, uploadStatus: status }) : state.clips,
  });
}

function enqueueJob(localId: string): Promise<void> {
  const existing = uploadsInFlight.get(localId);
  if (existing) return existing;
  const work = new Promise<void>((resolve, reject) => {
    jobResolvers.set(localId, { resolve, reject });
  });
  uploadsInFlight.set(localId, work);
  if (!pendingOrder.includes(localId) && useLibraryStore.getState().activeUploadId !== localId) {
    pendingOrder.push(localId);
    markQueued(localId);
  }
  void drainUploadQueue();
  return work;
}

async function runUploadWork(localId: string) {
  const token = useAuthStore.getState().session?.access_token;
  if (!token) {
    useToastStore.getState().show("Sign in to upload");
    return;
  }
  const next = await uploadLocalClip(localId, token, publicAppUrl());
  useLibraryStore.setState({ clips: patchClip(useLibraryStore.getState().clips, next) });
  await useCloudStore.getState().refresh();
  await useAuthStore.getState().refreshProfile();
}

async function drainUploadQueue() {
  if (drainRunning) return;
  drainRunning = true;
  try {
    while (pendingOrder.length > 0) {
      const localId = pendingOrder.shift()!;
      const waiter = jobResolvers.get(localId);
      if (cancelledUploads.delete(localId)) {
        removeQueueItem(localId);
        waiter?.resolve();
        jobResolvers.delete(localId);
        uploadsInFlight.delete(localId);
        continue;
      }
      useLibraryStore.setState({ activeUploadId: localId });
      patchQueueItem(localId, { phase: "preparing" });
      try {
        await runUploadWork(localId);
        waiter?.resolve();
      } catch (caught) {
        const message = invokeErrorMessage(caught, "Upload failed");
        useToastStore.getState().show(message.includes("Premium") ? `${message} Open Account to upgrade.` : message);
        await useLibraryStore.getState().refresh();
        waiter?.resolve();
      } finally {
        jobResolvers.delete(localId);
        uploadsInFlight.delete(localId);
        removeQueueItem(localId);
        useLibraryStore.setState({ activeUploadId: null });
      }
    }
  } finally {
    drainRunning = false;
    if (pendingOrder.length > 0) {
      void drainUploadQueue();
    }
  }
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

function currentShouldDefer(): boolean {
  return shouldDeferUpload(
    useSettingsStore.getState().settings,
    useDetectionStore.getState().snapshot,
    useRecordingStore.getState(),
  );
}

function enqueueOrUpload(localId: string, clip: LocalClip | undefined) {
  const settings = useSettingsStore.getState().settings;
  const signedIn = Boolean(useAuthStore.getState().user);
  if (!shouldAutoUpload(clip, settings, signedIn)) return;
  if (currentShouldDefer()) {
    pendingAutoUploads.add(localId);
    if (!deferToastShown) {
      deferToastShown = true;
      useToastStore.getState().show("Upload queued until you exit the game");
    }
    return;
  }
  void useLibraryStore.getState().upload(localId);
}

function flushDeferredUploads() {
  if (currentShouldDefer()) return;
  deferToastShown = false;
  const ids = [...pendingAutoUploads];
  pendingAutoUploads.clear();
  for (const localId of ids) {
    const clip = useLibraryStore.getState().clips.find((item) => item.localId === localId);
    enqueueOrUpload(localId, clip);
  }
}

export const useLibraryStore = create<LibraryState>((set, get) => ({
  clips: [],
  playingId: null,
  favoritesOnly: false,
  selectedIds: [],
  loaded: false,
  error: null,
  uploadQueue: [],
  activeUploadId: null,
  initialize: async () => {
    let interrupted: string[] = [];
    try {
      interrupted = await resetStaleUploads();
    } catch {
      interrupted = [];
    }
    await get().refresh();
    for (const localId of interrupted) {
      const clip = get().clips.find((item) => item.localId === localId);
      enqueueOrUpload(localId, clip);
    }
    if (!listening) {
      listening = true;
      await listen<{ localId?: string; path: string; kind: string }>("local-clip-saved", (event) => {
        void (async () => {
          await get().refresh();
          const localId = event.payload.localId;
          if (!localId) return;
          const clip = get().clips.find((item) => item.localId === localId);
          enqueueOrUpload(localId, clip);
        })();
      });
      await listen<CloudUploadEvent>("cloud-upload", (event) => {
        applyUploadEvent(event.payload);
      });
      await listen("recording-status", () => {
        flushDeferredUploads();
      });
      await listen("replay-status", () => {
        flushDeferredUploads();
      });
      await listen("detected-game", () => {
        flushDeferredUploads();
      });
      useSettingsStore.subscribe((state, prev) => {
        if (prev.settings.cloudUploadWhen === "afterGame" && state.settings.cloudUploadWhen === "immediate") {
          flushDeferredUploads();
        }
      });
    }
  },
  refresh: async () => {
    try {
      const clips = await listLocalClips(80);
      const queued = new Map(get().uploadQueue.map((item) => [item.localId, item.phase]));
      const merged = clips.map((clip) => {
        const phase = queued.get(clip.localId);
        if (phase === "queued" && clip.uploadStatus === "local") {
          return { ...clip, uploadStatus: "queued" as const };
        }
        return clip;
      });
      set({ clips: merged, loaded: true, error: null });
    } catch (caught) {
      const message = invokeErrorMessage(caught, "Could not load clips from this PC");
      console.warn("listLocalClips failed", caught);
      useToastStore.getState().show(message);
      set({ clips: [], loaded: true, error: message });
    }
  },
  play: (localId) => {
    useCloudStore.getState().closePlayer();
    set({ playingId: localId });
  },
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
      patchQueueItem(localId, { title: clipTitle(next) });
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
      if (value) {
        enqueueOrUpload(localId, next);
      }
    } catch (caught) {
      useToastStore.getState().show(invokeErrorMessage(caught, "Could not update favorite"));
    }
  },
  remove: async (localId) => {
    get().dequeueUpload(localId);
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
      get().dequeueUpload(localId);
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
    cancelledUploads.delete(localId);
    await enqueueJob(localId);
  },
  ensureCloudUpload: async (localId) => {
    pendingAutoUploads.delete(localId);
    const clip = get().clips.find((item) => item.localId === localId);
    if (!clip) return false;
    if (!isVideoPath(clip.filePath)) return false;
    if (clip.uploadStatus === "completed" && clip.cloudClipId) return true;
    if (!useAuthStore.getState().user) {
      useToastStore.getState().show("Sign in to upload");
      return false;
    }
    await get().upload(localId);
    const next = get().clips.find((item) => item.localId === localId);
    return Boolean(next?.cloudClipId && next.uploadStatus === "completed");
  },
  dequeueUpload: (localId) => {
    if (get().activeUploadId === localId) return;
    const waiting = pendingOrder.indexOf(localId);
    if (waiting < 0) return;
    pendingOrder.splice(waiting, 1);
    cancelledUploads.add(localId);
    const clip = get().clips.find((item) => item.localId === localId);
    removeQueueItem(localId);
    if (clip && clip.uploadStatus === "queued") {
      set({ clips: patchClip(get().clips, { ...clip, uploadStatus: "local" }) });
    }
    const waiter = jobResolvers.get(localId);
    waiter?.resolve();
    jobResolvers.delete(localId);
    uploadsInFlight.delete(localId);
    cancelledUploads.delete(localId);
  },
  download: async (localId) => {
    const clip = get().clips.find((item) => item.localId === localId);
    if (!clip) return;
    if (useAuthStore.getState().user) {
      void get().ensureCloudUpload(localId);
    }
    const ext = clip.filePath.split(".").pop() || "mp4";
    try {
      const dest = await save({
        defaultPath: suggestedFileName(clip.title, "clip", ext),
        title: "Download clip",
      });
      if (!dest) return;
      await exportLocalClip({ localId: clip.localId, source: clip.filePath, dest });
      useToastStore.getState().show("Saved to disk");
    } catch (caught) {
      useToastStore.getState().show(invokeErrorMessage(caught, "Could not download clip"));
    }
  },
  downloadMany: async (localIds) => {
    const clips = get().clips.filter((clip) => localIds.includes(clip.localId));
    if (clips.length === 0) return;
    if (useAuthStore.getState().user) {
      for (const clip of clips) {
        void get().ensureCloudUpload(clip.localId);
      }
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
        const ext = clip.filePath.split(".").pop() || "mp4";
        const dest = joinPath(folder, uniqueFileName(used, suggestedFileName(clip.title, "clip", ext)));
        try {
          await exportLocalClip({ localId: clip.localId, source: clip.filePath, dest });
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
    const uploaded = await get().ensureCloudUpload(localId);
    const clip = get().clips.find((item) => item.localId === localId);
    if (!uploaded || !clip?.cloudClipId) {
      if (uploaded) {
        useToastStore.getState().show("Could not find the cloud link yet");
      }
      return;
    }
    const cloud = useCloudStore.getState().clips.find((item) => item.id === clip.cloudClipId);
    if (!cloud) {
      await useCloudStore.getState().refresh();
    }
    const linked = useCloudStore.getState().clips.find((item) => item.id === clip.cloudClipId);
    if (!linked?.slug) {
      useToastStore.getState().show("Could not find the cloud link yet");
      return;
    }
    if (linked.visibility === "private") {
      useToastStore.getState().show("Private clips have no share link. Set Unlisted or Public first.");
      return;
    }
    try {
      await navigator.clipboard.writeText(clipShareUrl(linked.slug));
      useToastStore.getState().show(
        linked.visibility === "public" ? "Public link copied" : "Unlisted link copied",
      );
    } catch {
      useToastStore.getState().show("Could not copy link");
    }
  },
}));
