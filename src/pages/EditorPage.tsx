import { convertFileSrc } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { PageHeader } from "../components/common/PageHeader";
import { IconInstagram, IconTikTok, IconYoutube } from "../components/icons";
import {
  listClipFilmstrip,
  revealLocalClip,
  saveShortClip,
  saveTrimmedClip,
  setClipEditorCrop,
  setClipSourceLayout,
  shareLocalClip,
} from "../services/tauri";
import { mergeFolderEditDocument, type FolderEditDocument } from "../services/social-types";
import { useAuthStore } from "../stores/authStore";
import { useCloudStore } from "../stores/cloudStore";
import { useEditorContextStore } from "../stores/editorContextStore";
import { useFolderStore } from "../stores/folderStore";
import { useLibraryStore } from "../stores/libraryStore";
import { useToastStore } from "../stores/toastStore";
import type { ClipSourceLayout, CloudClip, LocalClip } from "../types/clip";
import type { WebcamPlacement, WebcamShape } from "../types/settings";
import { formatClock, formatDuration, invokeErrorMessage, isVideoPath, parseClock } from "../utils/format";
import { trackClipRenderFailed, trackClipRendered, trackClipSaveFailed, trackEditorOpened } from "../services/analytics";
import { clipWebcamSource, nearestWebcamPlacement, normalizeUploadStatus, parseSourceLayout, webcamOverlayStyle } from "../utils/clips";

const MIN_TRIM_MS = 1000;
const SHORTS_WARN_MS = 60_000;
// Part of the on-disk filmstrip cache key, so keep it stable across resizes.
const STRIP_TILES = 12;
const WEBCAM_DRIFT_S = 0.05;
/** Webcam vs gameplay offset (seconds). Positive = delay cam. */
const WEBCAM_LAG_S = 0;
const WEBCAM_PLACEMENTS: { id: WebcamPlacement; label: string }[] = [
  { id: "top-left", label: "Top Left" },
  { id: "top-right", label: "Top Right" },
  { id: "bottom-left", label: "Bottom Left" },
  { id: "bottom-right", label: "Bottom Right" },
];
const WEBCAM_SHAPES: { id: WebcamShape; label: string }[] = [
  { id: "rectangle", label: "Rectangle" },
  { id: "rounded", label: "Rounded" },
  { id: "circle", label: "Circle" },
];

type DragKind = "start" | "end" | "playhead";
type SaveKind = "trim" | "short";

function asMs(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.round(value));
}

function clampPan(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}

function clampRange(startMs: number, endMs: number, durationMs: number): { startMs: number; endMs: number } {
  const duration = Math.max(asMs(durationMs), MIN_TRIM_MS);
  const start = Math.max(0, Math.min(asMs(startMs), duration - MIN_TRIM_MS));
  const end = Math.max(start + MIN_TRIM_MS, Math.min(asMs(endMs), duration));
  return { startMs: start, endMs: end };
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

function waitVideoEvent(video: HTMLVideoElement, event: string, timeoutMs = 800): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      video.removeEventListener(event, onEvent);
      reject(new Error(`${event} timed out`));
    }, timeoutMs);
    function onEvent() {
      window.clearTimeout(timer);
      resolve();
    }
    video.addEventListener(event, onEvent, { once: true });
  });
}

function waitForVideoFrame(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve) => {
    const withFrame = video as HTMLVideoElement & {
      requestVideoFrameCallback?: (callback: () => void) => number;
    };
    if (typeof withFrame.requestVideoFrameCallback === "function") {
      withFrame.requestVideoFrameCallback(() => resolve());
      return;
    }
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()));
  });
}

async function ensureFirstFrame(video: HTMLVideoElement): Promise<void> {
  try {
    if (Math.abs(video.currentTime) < 0.0005) {
      video.currentTime = 0.001;
      await waitVideoEvent(video, "seeked").catch(() => undefined);
    }
    video.currentTime = 0;
    await waitVideoEvent(video, "seeked").catch(() => undefined);
    await waitForVideoFrame(video);
  } catch {
    // Poster covers the wait; a later scrub still paints a frame.
  }
}

function cropOverlay(
  width: number,
  height: number,
  pan: number,
): { left: number; width: number; visible: boolean } {
  if (width < 2 || height < 2) return { left: 0, width: 1, visible: false };
  const src = width / height;
  const target = 9 / 16;
  if (Math.abs(src - target) / target < 0.02) {
    return { left: 0, width: 1, visible: false };
  }
  if (src > target) {
    const window = (height * target) / width;
    const left = (1 - window) * clampPan(pan);
    return { left, width: window, visible: true };
  }
  return { left: 0, width: 1, visible: false };
}

function panFromClientX(clientX: number, rect: DOMRect, windowPct: number): number {
  const windowPx = rect.width * windowPct;
  const max = Math.max(1, rect.width - windowPx);
  const x = clientX - rect.left - windowPx / 2;
  return clampPan(x / max);
}

function documentFromEditor(startMs: number, endMs: number, pan: number, webcam: ClipSourceLayout): FolderEditDocument {
  const layout = { ...webcam } as FolderEditDocument["webcam"];
  return {
    version: 1,
    trim: { startMs: asMs(startMs), endMs: asMs(endMs) },
    composition: { cropX: clampPan(pan), webcam: layout },
    webcam: layout,
  };
}

export function EditorPage() {
  const { clipId, folderId, editId } = useParams();
  const navigate = useNavigate();
  const clips = useLibraryStore((state) => state.clips);
  const loaded = useLibraryStore((state) => state.loaded);
  const closePlayer = useLibraryStore((state) => state.closePlayer);
  const play = useLibraryStore((state) => state.play);
  const rename = useLibraryStore((state) => state.rename);
  const ensureCloudUpload = useLibraryStore((state) => state.ensureCloudUpload);
  const copyLink = useLibraryStore((state) => state.copyLink);
  const download = useLibraryStore((state) => state.download);
  const refresh = useLibraryStore((state) => state.refresh);
  const user = useAuthStore((state) => state.user);
  const editorContext = useEditorContextStore((state) => state.context);
  const setPersonal = useEditorContextStore((state) => state.setPersonal);
  const patchFolderEdit = useEditorContextStore((state) => state.patchFolderEdit);
  const setFolderEdit = useEditorContextStore((state) => state.setFolderEdit);
  const saveFolderEdit = useFolderStore((state) => state.saveEdit);
  const getFolderEdit = useFolderStore((state) => state.getEdit);
  const attachRender = useFolderStore((state) => state.attachRender);
  const playFolderClip = useFolderStore((state) => state.playClip);
  const openFolder = useFolderStore((state) => state.open);
  const activeFolder = useFolderStore((state) => state.activeFolder);
  const cloudClips = useCloudStore((state) => state.clips);
  const setVisibility = useCloudStore((state) => state.setVisibility);
  const showToast = useToastStore((state) => state.show);

  const folderSession =
    editorContext.kind === "folderEdit" && editorContext.folderId === folderId && editorContext.editId === editId
      ? editorContext
      : null;
  const localSource = clipId
    ? clips.find((item) => item.localId === clipId) ?? null
    : folderSession
      ? clips.find((item) => item.localId === folderSession.localId || item.cloudClipId === folderSession.sourceClipId) ??
        null
      : null;
  const source =
    localSource ??
    (folderSession
      ? ({
          localId: `folder:${folderSession.editId}`,
          cloudClipId: folderSession.sourceClipId,
          filePath: folderSession.playbackUrl,
          thumbnailPath: null,
          gameId: null,
          createdAt: new Date().toISOString(),
          durationMs: folderSession.editData.trim?.endMs ?? null,
          width: null,
          height: null,
          fps: null,
          fileSize: null,
          uploadStatus: "local",
          favorite: false,
          title: folderSession.sourceTitle,
          description: null,
          sourceClipId: folderSession.sourceClipId,
          sourceStartMs: folderSession.editData.trim?.startMs ?? null,
          sourceEndMs: folderSession.editData.trim?.endMs ?? null,
          editorCropX: folderSession.editData.composition?.cropX,
        } satisfies LocalClip)
      : null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const webcamRef = useRef<HTMLVideoElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragKind | null>(null);
  const webcamDragRef = useRef<{
    originX: number;
    originY: number;
    startClientX: number;
    startClientY: number;
    boxW: number;
    boxH: number;
  } | null>(null);
  const [webcamDragging, setWebcamDragging] = useState(false);
  const reframeDragRef = useRef(false);
  const panRef = useRef(0.5);

  const [videoMs, setVideoMs] = useState(0);
  const [frameSize, setFrameSize] = useState({ width: 0, height: 0 });
  const [startMs, setStartMs] = useState(0);
  const [endMs, setEndMs] = useState(0);
  const [playheadMs, setPlayheadMs] = useState(0);
  const [startText, setStartText] = useState("00:00");
  const [endText, setEndText] = useState("00:00");
  const [playing, setPlaying] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [savingKind, setSavingKind] = useState<SaveKind | null>(null);
  const [sharing, setSharing] = useState(false);
  const [sharingFile, setSharingFile] = useState(false);
  const [saved, setSaved] = useState<LocalClip | null>(null);
  const [savedKind, setSavedKind] = useState<SaveKind | null>(null);
  const [savedTitle, setSavedTitle] = useState("");
  const [stripFrames, setStripFrames] = useState<Array<{ path: string; atMs: number }>>([]);
  const [pan, setPan] = useState(0.5);
  const [shortsMode, setShortsMode] = useState(false);
  const [webcamLayout, setWebcamLayout] = useState<ClipSourceLayout>(() => parseSourceLayout(null));

  panRef.current = pan;
  const webcamLayoutRef = useRef(webcamLayout);
  webcamLayoutRef.current = webcamLayout;
  const saving = savingKind !== null;
  const durationMs = Math.max(source?.durationMs ?? 0, videoMs);
  const savedClip = clips.find((item) => item.localId === saved?.localId) ?? saved;
  const cloud = savedClip?.cloudClipId
    ? cloudClips.find((item) => item.id === savedClip.cloudClipId) ?? null
    : null;
  const uploadStatus = normalizeUploadStatus(savedClip?.uploadStatus);
  const uploading = ["queued", "preparing", "uploading", "processing"].includes(uploadStatus);
  const overlay = cropOverlay(
    frameSize.width || source?.width || 0,
    frameSize.height || source?.height || 0,
    pan,
  );
  const poster = source?.thumbnailPath ? convertFileSrc(source.thumbnailPath) : undefined;
  const webcamSource = clipWebcamSource(source);
  const webcamMedia = useMemo(
    () => (webcamSource ? convertFileSrc(webcamSource.filePath) : ""),
    [webcamSource?.filePath],
  );

  function syncWebcam(master: HTMLVideoElement) {
    const cam = webcamRef.current;
    if (!cam || !webcamMedia) return;
    const target = Math.max(0, master.currentTime - WEBCAM_LAG_S);
    const drift = Math.abs(cam.currentTime - target);
    if (drift > WEBCAM_DRIFT_S) {
      cam.currentTime = target;
    }
    if (master.paused) {
      if (!cam.paused) cam.pause();
    } else if (cam.paused) {
      void cam.play().catch(() => undefined);
    }
  }

  useEffect(() => {
    closePlayer();
  }, [closePlayer]);

  useEffect(() => {
    if (!folderId || !editId) {
      if (editorContext.kind === "folderEdit") setPersonal();
      return;
    }
    if (folderSession) return;
    let cancelled = false;
    void (async () => {
      const folder = activeFolder?.id === folderId ? activeFolder : (await openFolder(folderId), useFolderStore.getState().activeFolder);
      let foundClipId: string | undefined;
      if (folder) {
        foundClipId = folder.clips.find((item) =>
          (useFolderStore.getState().editsByClip[item.id] ?? []).some((edit) => edit.id === editId),
        )?.id;
        if (!foundClipId) {
          for (const item of folder.clips) {
            const loadedEdits = await useFolderStore.getState().loadEdits(folderId, item.id);
            if (cancelled) return;
            if (loadedEdits.some((edit) => edit.id === editId)) {
              foundClipId = item.id;
              break;
            }
          }
        }
      }
      if (!foundClipId || cancelled) return;
      const edit = await getFolderEdit(folderId, foundClipId, editId);
      const playbackUrl = await playFolderClip(folderId, foundClipId);
      const nextFolder = useFolderStore.getState().activeFolder;
      if (!edit || !playbackUrl || !nextFolder || cancelled) return;
      setFolderEdit({
        kind: "folderEdit",
        folderId,
        folderName: nextFolder.name,
        sourceClipId: foundClipId,
        sourceTitle: nextFolder.clips.find((item) => item.id === foundClipId)?.title || "Untitled clip",
        editId: edit.id,
        editName: edit.name,
        revision: edit.revision,
        permissions: nextFolder.permissions,
        playbackUrl,
        localId: clips.find((item) => item.cloudClipId === foundClipId)?.localId ?? null,
        editData: edit.editData,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [activeFolder, clips, editId, editorContext.kind, folderId, folderSession, getFolderEdit, openFolder, playFolderClip, setFolderEdit, setPersonal]);

  useEffect(() => {
    if (!loaded) return;
    if (folderId && editId) return;
    if (!source || !isVideoPath(source.filePath)) {
      navigate("/library", { replace: true });
    }
  }, [editId, folderId, loaded, source, navigate]);

  useEffect(() => {
    if (!source) return;
    const duration = Math.max(source.durationMs ?? 0, MIN_TRIM_MS);
    setStartMs(0);
    setEndMs(duration);
    setPlayheadMs(0);
    setStartText(formatClock(0, true));
    setEndText(formatClock(duration, true));
    setSaved(null);
    setSavedKind(null);
    setPreviewing(false);
    setShortsMode(false);
    setPan(clampPan(source.editorCropX ?? 0.5));
    setFrameSize({ width: source.width ?? 0, height: source.height ?? 0 });
    setStripFrames([]);
    const video = videoRef.current;
    if (video) {
      video.pause();
      video.currentTime = 0;
    }
    webcamRef.current?.pause();
    const stored = folderSession?.editData;
    if (stored?.trim) {
      const next = clampRange(stored.trim.startMs, stored.trim.endMs || duration, duration);
      setStartMs(next.startMs);
      setEndMs(next.endMs);
      setStartText(formatClock(next.startMs, true));
      setEndText(formatClock(next.endMs, true));
      setPan(clampPan(stored.composition?.cropX ?? source.editorCropX ?? 0.5));
    }
    const webcam = stored?.webcam ?? stored?.composition?.webcam;
    setWebcamLayout(
      webcam
        ? {
            placement: (webcam.placement as ClipSourceLayout["placement"]) ?? "bottom-right",
            shape: (webcam.shape as ClipSourceLayout["shape"]) ?? "rounded",
            width: webcam.width ?? 0.22,
            x: webcam.x,
            y: webcam.y,
          }
        : parseSourceLayout(clipWebcamSource(source)?.layoutJson),
    );
  }, [source?.localId, folderSession?.editId]);

  useEffect(() => {
    if (!source) return;
    trackEditorOpened({
      localId: source.localId,
      folderId,
      editId,
      durationMs: source.durationMs,
      webcamEnabled: Boolean(clipWebcamSource(source)),
    });
  }, [source?.localId, folderSession?.editId, folderId, editId]);

  useEffect(() => {
    if (!source || (folderSession && !localSource)) {
      setStripFrames([]);
      return;
    }
    let cancelled = false;
    setStripFrames([]);
    void (async () => {
      const frames = await listClipFilmstrip(source.localId, STRIP_TILES);
      if (!cancelled) setStripFrames(frames);
    })();
    return () => {
      cancelled = true;
    };
  }, [folderSession, localSource, source?.localId]);

  const applyRange = useCallback(
    (nextStart: number, nextEnd: number) => {
      const next = clampRange(nextStart, nextEnd, durationMs);
      setStartMs(next.startMs);
      setEndMs(next.endMs);
      setStartText(formatClock(next.startMs, true));
      setEndText(formatClock(next.endMs, true));
      return next;
    },
    [durationMs],
  );

  const seekTo = useCallback((ms: number) => {
    const clamped = Math.max(0, Math.min(asMs(ms), asMs(durationMs)));
    setPlayheadMs(clamped);
    const video = videoRef.current;
    if (video && Number.isFinite(clamped / 1000)) {
      video.currentTime = clamped / 1000;
    }
    const cam = webcamRef.current;
    if (cam && Number.isFinite(clamped / 1000)) {
      cam.currentTime = Math.max(0, clamped / 1000 - WEBCAM_LAG_S);
    }
  }, [durationMs]);

  const msFromClientX = useCallback((clientX: number) => {
    const node = timelineRef.current;
    if (!node || durationMs <= 0) return 0;
    const rect = node.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return asMs(ratio * durationMs);
  }, [durationMs]);

  const persistPan = useCallback(
    (next: number) => {
      if (!source) return;
      const clamped = clampPan(next);
      setPan(clamped);
      if (folderSession) return;
      const previous = pan;
      void setClipEditorCrop(source.localId, clamped).catch((caught) => {
        setPan(previous);
        showToast(invokeErrorMessage(caught, "Could not save crop"));
      });
    },
    [folderSession, source?.localId, pan, showToast],
  );

  const persistWebcamLayout = useCallback(
    (next: ClipSourceLayout) => {
      if (!source) return;
      setWebcamLayout(next);
      if (folderSession || !webcamSource) return;
      const previous = webcamLayout;
      void setClipSourceLayout(source.localId, webcamSource.sourceInstanceId, next)
        .then((clip) => {
          useLibraryStore.setState({
            clips: useLibraryStore.getState().clips.map((item) => (item.localId === clip.localId ? clip : item)),
          });
        })
        .catch((caught) => {
          setWebcamLayout(previous);
          showToast(invokeErrorMessage(caught, "Could not save webcam layout"));
        });
    },
    [folderSession, source?.localId, webcamSource?.sourceInstanceId, webcamLayout, showToast],
  );

  useEffect(() => {
    function onMove(event: PointerEvent) {
      if (webcamDragRef.current) {
        const node = previewRef.current;
        const drag = webcamDragRef.current;
        if (!node) return;
        const rect = node.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;
        const dx = (event.clientX - drag.startClientX) / rect.width;
        const dy = (event.clientY - drag.startClientY) / rect.height;
        const x = Math.max(0, Math.min(1 - drag.boxW, drag.originX + dx));
        const y = Math.max(0, Math.min(1 - drag.boxH, drag.originY + dy));
        setWebcamLayout((prev) => ({
          ...prev,
          x,
          y,
          placement: nearestWebcamPlacement(x, y, drag.boxW, drag.boxH),
        }));
        return;
      }
      if (reframeDragRef.current) {
        const node = previewRef.current;
        if (!node || !overlay.visible) return;
        const next = panFromClientX(event.clientX, node.getBoundingClientRect(), overlay.width);
        setPan(next);
        return;
      }
      const kind = dragRef.current;
      if (!kind) return;
      const at = msFromClientX(event.clientX);
      if (kind === "start") {
        applyRange(Math.min(at, endMs - MIN_TRIM_MS), endMs);
        seekTo(Math.min(at, endMs - MIN_TRIM_MS));
      } else if (kind === "end") {
        applyRange(startMs, Math.max(at, startMs + MIN_TRIM_MS));
        seekTo(Math.max(at, startMs + MIN_TRIM_MS));
      } else {
        videoRef.current?.pause();
        seekTo(at);
      }
    }
    function onUp() {
      if (webcamDragRef.current) {
        webcamDragRef.current = null;
        setWebcamDragging(false);
        persistWebcamLayout(webcamLayoutRef.current);
        return;
      }
      if (reframeDragRef.current) {
        reframeDragRef.current = false;
        persistPan(panRef.current);
      }
      dragRef.current = null;
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [applyRange, endMs, msFromClientX, overlay.visible, overlay.width, persistPan, persistWebcamLayout, seekTo, startMs]);

  const saveRef = useRef<(share: boolean) => Promise<void>>(async () => {});
  const togglePlayRef = useRef<() => void>(() => {});
  const rangeRef = useRef({ startMs, endMs, playheadMs });
  rangeRef.current = { startMs, endMs, playheadMs };

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (isTypingTarget(event.target)) return;
      if (useLibraryStore.getState().playingId) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveRef.current(false);
        return;
      }
      if (event.key === " " || event.code === "Space") {
        event.preventDefault();
        togglePlayRef.current();
        return;
      }
      const latest = rangeRef.current;
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        const delta = (event.shiftKey ? 5000 : 1000) * (event.key === "ArrowLeft" ? -1 : 1);
        seekTo(latest.playheadMs + delta);
        return;
      }
      if (event.key === "i" || event.key === "I") {
        event.preventDefault();
        applyRange(latest.playheadMs, latest.endMs);
        return;
      }
      if (event.key === "o" || event.key === "O") {
        event.preventDefault();
        applyRange(latest.startMs, latest.playheadMs);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [applyRange, seekTo]);

  const selectedMs = Math.max(0, endMs - startMs);
  const startPct = durationMs > 0 ? (startMs / durationMs) * 100 : 0;
  const endPct = durationMs > 0 ? (endMs / durationMs) * 100 : 100;
  const playheadPct = durationMs > 0 ? (playheadMs / durationMs) * 100 : 0;
  const canSave =
    Boolean(source) &&
    selectedMs >= MIN_TRIM_MS &&
    !saving &&
    (!folderSession || folderSession.permissions.modifyEdits);
  const longShort = selectedMs > SHORTS_WARN_MS;

  function togglePlay() {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      setPreviewing(false);
      void video.play();
    } else {
      video.pause();
    }
  }
  togglePlayRef.current = togglePlay;

  function previewSelection() {
    const video = videoRef.current;
    if (!video) return;
    setPreviewing(true);
    seekTo(startMs);
    void video.play();
  }

  function resetRange() {
    applyRange(0, durationMs);
    seekTo(0);
    setPreviewing(false);
    setShortsMode(false);
    videoRef.current?.pause();
    webcamRef.current?.pause();
  }

  function commitClock(which: "start" | "end", value: string) {
    const parsed = parseClock(value);
    if (parsed == null) {
      if (which === "start") setStartText(formatClock(startMs, true));
      else setEndText(formatClock(endMs, true));
      return;
    }
    if (which === "start") applyRange(parsed, endMs);
    else applyRange(startMs, parsed);
  }

  async function saveClip(kind: SaveKind, share: boolean) {
    if (!source || saving) return;
    if (folderSession) {
      if (!folderSession.permissions.modifyEdits) {
        showToast("You do not have permission to edit this folder version.");
        return;
      }
      setSavingKind(kind);
      try {
        const savedEdit = await saveFolderEdit(folderSession.folderId, folderSession.sourceClipId, folderSession.editId, {
          expectedRevision: folderSession.revision,
          editData: mergeFolderEditDocument(folderSession.editData, documentFromEditor(startMs, endMs, pan, webcamLayout)),
        });
        if (savedEdit) {
          patchFolderEdit({ revision: savedEdit.revision, editData: savedEdit.editData, editName: savedEdit.name });
          showToast("Folder edit saved. The original clip was not changed.");
        }
      } finally {
        setSavingKind(null);
      }
      return;
    }
    setSavingKind(kind);
    try {
      const next =
        kind === "short"
          ? await saveShortClip(source.localId, asMs(startMs), asMs(endMs), pan)
          : await saveTrimmedClip(source.localId, asMs(startMs), asMs(endMs));
      setSaved(next);
      setSavedKind(kind);
      setSavedTitle(next.title || "");
      if (kind === "short") trackClipRendered({ kind: "short", localId: next.localId });
      await refresh();
      if (share) {
        if (!user) {
          showToast("Sign in to share");
          return;
        }
        setSharing(true);
        await copyLink(next.localId);
      } else {
        showToast(kind === "short" ? "Saved as a Short" : "Saved as a new clip");
      }
    } catch (caught) {
      const message = invokeErrorMessage(caught, kind === "short" ? "Could not save that Short" : "Could not save that trim");
      showToast(message);
      trackClipSaveFailed(message);
      if (kind === "short") trackClipRenderFailed({ kind: "short", message });
    } finally {
      setSavingKind(null);
      setSharing(false);
    }
  }
  saveRef.current = (share) => saveClip(shortsMode ? "short" : "trim", share);

  async function shareSaved() {
    if (!savedClip) return;
    if (!user) {
      showToast("Sign in to share");
      return;
    }
    setSharing(true);
    try {
      await copyLink(savedClip.localId);
    } finally {
      setSharing(false);
    }
  }

  async function shareSavedFile() {
    if (!savedClip) return;
    setSharingFile(true);
    try {
      if (user) {
        void ensureCloudUpload(savedClip.localId);
      }
      const how = await shareLocalClip({ localId: savedClip.localId, filePath: savedClip.filePath });
      if (how === "clipboard") {
        showToast("Clip copied. Paste it into TikTok, CapCut, Explorer, or an upload dialog.");
      } else if (how === "folder") {
        showToast("Opened the clip’s folder.");
      }
    } catch (caught) {
      showToast(invokeErrorMessage(caught, "Could not share that file"));
    } finally {
      setSharingFile(false);
    }
  }

  async function saveEditedCopy() {
    if (!folderSession || !localSource || saving) return;
    setSavingKind("trim");
    try {
      const next = await saveTrimmedClip(localSource.localId, asMs(startMs), asMs(endMs), folderSession.editName);
      await refresh();
      await ensureCloudUpload(next.localId);
      let cloudId: string | null = null;
      for (let attempt = 0; attempt < 40 && !cloudId; attempt += 1) {
        const uploaded = useLibraryStore.getState().clips.find((item) => item.localId === next.localId);
        if (uploaded?.cloudClipId && uploaded.uploadStatus === "completed") {
          cloudId = uploaded.cloudClipId;
          break;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 500));
      }
      if (!cloudId) {
        showToast("Saved a local copy. Upload it to attach a rendered copy to the folder.");
        return;
      }
      await attachRender(folderSession.folderId, folderSession.sourceClipId, folderSession.editId, cloudId);
      trackClipRendered({ kind: "folder_edit", localId: next.localId, folderId: folderSession.folderId });
      showToast("Rendered copy added to the folder. The original is unchanged.");
    } catch (caught) {
      const message = invokeErrorMessage(caught, "Could not save that edited copy");
      showToast(message);
      trackClipRenderFailed({ kind: "folder_edit", message });
    } finally {
      setSavingKind(null);
    }
  }

  const media = useMemo(() => {
    if (!source) return "";
    if (source.filePath.startsWith("http://") || source.filePath.startsWith("https://")) return source.filePath;
    return convertFileSrc(source.filePath);
  }, [source]);

  if (!source) {
    return <p className="muted">Loading clip…</p>;
  }

  return (
    <div
      className="editor-layout"
      style={
        frameSize.width > 0 && frameSize.height > 0
          ? ({ "--editor-aspect": frameSize.width / frameSize.height } as CSSProperties)
          : undefined
      }
    >
      <PageHeader
        title={folderSession ? folderSession.editName : source.title || "Untitled clip"}
        subtitle={
          folderSession
            ? `${folderSession.folderName} / ${folderSession.sourceTitle} · Shared Edit · the clean original is not overwritten`
            : "Trim a new local MP4. The original file stays unchanged."
        }
      >
        {folderSession ? <span className="badge editor-shared-badge">Shared Edit</span> : null}
        <Link
          className="btn"
          to={folderSession ? `/library/folders/${folderSession.folderId}` : "/library"}
          onClick={() => closePlayer()}
        >
          Back
        </Link>
      </PageHeader>

      <div className="editor-stage player-stage">
        <div ref={previewRef} className="editor-preview">
          <video
            ref={videoRef}
            className="editor-gameplay"
            src={media}
            poster={poster}
            controls={false}
            onClick={togglePlay}
            onLoadedMetadata={(event) => {
              const video = event.currentTarget;
              const next = asMs(video.duration * 1000);
              if (next > 0) {
                setVideoMs(next);
                if ((source.durationMs ?? 0) <= 0) {
                  applyRange(0, next);
                }
              }
              if (video.videoWidth > 0 && video.videoHeight > 0) {
                setFrameSize({ width: video.videoWidth, height: video.videoHeight });
              }
              void ensureFirstFrame(video);
            }}
            onTimeUpdate={(event) => {
              const video = event.currentTarget;
              const ms = asMs(video.currentTime * 1000);
              setPlayheadMs(ms);
              syncWebcam(video);
              if (previewing && ms >= endMs) {
                video.pause();
                video.currentTime = endMs / 1000;
                setPlayheadMs(asMs(endMs));
                setPreviewing(false);
              }
            }}
            onPlay={(event) => {
              setPlaying(true);
              syncWebcam(event.currentTarget);
            }}
            onPause={(event) => {
              setPlaying(false);
              syncWebcam(event.currentTarget);
            }}
            onSeeked={(event) => syncWebcam(event.currentTarget)}
          />
          {webcamMedia ? (
            <div
              className={`editor-webcam draggable place-${webcamLayout.placement} shape-${webcamLayout.shape}${webcamDragging ? " dragging" : ""}${webcamLayout.x != null && webcamLayout.y != null ? " free" : ""}`}
              style={webcamOverlayStyle(webcamLayout)}
              title="Drag to reposition"
              onPointerDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                const preview = previewRef.current;
                const target = event.currentTarget;
                if (!preview) return;
                const rect = preview.getBoundingClientRect();
                const box = target.getBoundingClientRect();
                if (rect.width <= 0 || rect.height <= 0) return;
                const boxW = box.width / rect.width;
                const boxH = box.height / rect.height;
                const originX =
                  webcamLayout.x != null ? webcamLayout.x : (box.left - rect.left) / rect.width;
                const originY =
                  webcamLayout.y != null ? webcamLayout.y : (box.top - rect.top) / rect.height;
                webcamDragRef.current = {
                  originX,
                  originY,
                  startClientX: event.clientX,
                  startClientY: event.clientY,
                  boxW,
                  boxH,
                };
                setWebcamDragging(true);
                setWebcamLayout((prev) => ({
                  ...prev,
                  x: originX,
                  y: originY,
                  placement: nearestWebcamPlacement(originX, originY, boxW, boxH),
                }));
              }}
            >
              <video
                ref={webcamRef}
                src={webcamMedia}
                muted
                playsInline
                preload="auto"
                controls={false}
                draggable={false}
                onLoadedMetadata={(event) => {
                  const master = videoRef.current;
                  if (master) {
                    event.currentTarget.currentTime = Math.max(0, master.currentTime - WEBCAM_LAG_S);
                  }
                }}
              />
            </div>
          ) : null}
          {shortsMode && overlay.visible ? (
            <div
              className="editor-reframe interactive"
              onPointerDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                reframeDragRef.current = true;
                const node = previewRef.current;
                if (!node) return;
                setPan(panFromClientX(event.clientX, node.getBoundingClientRect(), overlay.width));
              }}
            >
              <div className="editor-reframe-dim" style={{ width: `${overlay.left * 100}%` }} />
              <div
                className="editor-reframe-window"
                style={{ left: `${overlay.left * 100}%`, width: `${overlay.width * 100}%` }}
              />
              <div
                className="editor-reframe-dim"
                style={{ left: `${(overlay.left + overlay.width) * 100}%`, right: 0 }}
              />
            </div>
          ) : null}
        </div>
      </div>

      <div className="editor-transport">
        <button type="button" className="btn primary" onClick={togglePlay}>
          {playing ? "Pause" : "Play"}
        </button>
        <strong>{formatClock(playheadMs, true)}</strong>
        <span className="muted">/ {formatClock(durationMs, true)}</span>
      </div>

      <div
        ref={timelineRef}
        className="editor-timeline"
        onPointerDown={(event) => {
          if ((event.target as HTMLElement).dataset.handle) return;
          dragRef.current = "playhead";
          videoRef.current?.pause();
          seekTo(msFromClientX(event.clientX));
        }}
      >
        <div className="editor-strip">
          {stripFrames.length > 0
            ? stripFrames.map((frame) => (
                <img key={frame.path} src={convertFileSrc(frame.path)} alt="" draggable={false} />
              ))
            : Array.from({ length: STRIP_TILES }, (_, index) => (
                <span key={index} className="editor-strip-empty" />
              ))}
        </div>
        <div className="editor-dim" style={{ left: 0, width: `${startPct}%` }} />
        <div className="editor-dim" style={{ left: `${endPct}%`, right: 0 }} />
        <div className="editor-range" style={{ left: `${startPct}%`, width: `${Math.max(0, endPct - startPct)}%` }} />
        <button
          type="button"
          className="editor-handle"
          data-handle="start"
          style={{ left: `${startPct}%` }}
          aria-label="Trim start"
          onPointerDown={(event) => {
            event.stopPropagation();
            dragRef.current = "start";
          }}
        />
        <button
          type="button"
          className="editor-handle"
          data-handle="end"
          style={{ left: `${endPct}%` }}
          aria-label="Trim end"
          onPointerDown={(event) => {
            event.stopPropagation();
            dragRef.current = "end";
          }}
        />
        <button
          type="button"
          className="editor-playhead"
          data-handle="playhead"
          style={{ left: `${playheadPct}%` }}
          aria-label="Playhead"
          onPointerDown={(event) => {
            event.stopPropagation();
            dragRef.current = "playhead";
            videoRef.current?.pause();
          }}
        />
      </div>

      <div className="editor-fields">
        <label>
          Start
          <input
            value={startText}
            aria-label="Trim start"
            onChange={(event) => setStartText(event.target.value)}
            onBlur={(event) => commitClock("start", event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
        </label>
        <label>
          End
          <input
            value={endText}
            aria-label="Trim end"
            onChange={(event) => setEndText(event.target.value)}
            onBlur={(event) => commitClock("end", event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
        </label>
        <div className="editor-duration">
          <span className="muted">Selected</span>
          <strong>{formatDuration(selectedMs)}</strong>
        </div>
      </div>

      {webcamMedia ? (
        <div className="editor-webcam-controls">
          <span className="settings-group-label">Webcam overlay</span>
          <p className="muted editor-webcam-hint">Drag the camera on the preview, or snap to a corner.</p>
          <div className="placement-grid" role="group" aria-label="Webcam position">
            {WEBCAM_PLACEMENTS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`placement-cell ${webcamLayout.placement === item.id ? "on" : ""}`}
                onClick={() =>
                  persistWebcamLayout({ ...webcamLayout, placement: item.id, x: null, y: null })
                }
              >
                {item.label}
              </button>
            ))}
          </div>
          <div className="shape-row">
            {WEBCAM_SHAPES.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`chip ${webcamLayout.shape === item.id ? "on" : ""}`}
                onClick={() => persistWebcamLayout({ ...webcamLayout, shape: item.id })}
              >
                {item.label}
              </button>
            ))}
          </div>
          <label className="setting-row">
            <span>Size</span>
            <span className="muted">{Math.round(webcamLayout.width * 100)}%</span>
          </label>
          <input
            type="range"
            min={12}
            max={40}
            value={Math.round(webcamLayout.width * 100)}
            onChange={(event) =>
              persistWebcamLayout({ ...webcamLayout, width: Number(event.target.value) / 100 })
            }
          />
        </div>
      ) : null}

      <p className="muted editor-hint">
        Space plays, I / O set in and out, arrows nudge 1s (Shift 5s). Start may snap back by up to about 2 seconds to
        the previous keyframe.
      </p>
      {longShort && shortsMode ? (
        <p className="muted editor-hint">Longer than 60 seconds — some apps cap Shorts there. You can still save.</p>
      ) : null}

      <div className="row editor-actions">
        <button type="button" className="btn" onClick={resetRange}>
          Reset
        </button>
        <button type="button" className="btn" onClick={previewSelection}>
          {playing && previewing ? "Previewing…" : "Preview Selection"}
        </button>
        <button
          type="button"
          className={`btn ${shortsMode ? "primary" : ""}`}
          disabled={!canSave}
          onClick={() => void saveClip(shortsMode ? "short" : "trim", false)}
        >
          {saving
            ? folderSession
              ? "Saving…"
              : shortsMode
                ? "Saving Short…"
                : "Saving…"
            : folderSession
              ? "Save Folder Edit"
              : "Save as New Clip"}
        </button>
        {folderSession && localSource ? (
          <button type="button" className="btn" disabled={!canSave || !folderSession.permissions.renderEdits} onClick={() => void saveEditedCopy()}>
            Save Edited Copy
          </button>
        ) : null}
        {folderSession ? null : <button
          type="button"
          className={`btn editor-short-btn ${shortsMode ? "on" : "primary"}`}
          disabled={shortsMode}
          aria-pressed={shortsMode}
          onClick={() => setShortsMode(true)}
        >
          <span className="editor-brand-logos" aria-hidden="true">
            <IconTikTok className="logo-tiktok" />
            <IconInstagram className="logo-instagram" />
            <IconYoutube className="logo-youtube" />
          </span>
          Save as Short
        </button>}
      </div>
      {shortsMode ? (
        <p className="muted editor-hint editor-short-hint">
          <span className="editor-brand-logos" aria-hidden="true">
            <IconTikTok className="logo-tiktok" />
            <IconInstagram className="logo-instagram" />
            <IconYoutube className="logo-youtube" />
          </span>
          Drag to frame, then Save as New Clip. 1080×1920 for TikTok, Instagram Reels, and YouTube Shorts.
        </p>
      ) : (
        <p className="muted editor-hint editor-short-hint">
          <span className="editor-brand-logos" aria-hidden="true">
            <IconTikTok className="logo-tiktok" />
            <IconInstagram className="logo-instagram" />
            <IconYoutube className="logo-youtube" />
          </span>
          1080×1920 for TikTok, Instagram Reels, and YouTube Shorts.
        </p>
      )}

      {savedClip ? (
        <section className="panel stack editor-success">
          <h2>{savedKind === "short" ? "Short saved" : "New clip saved"}</h2>
          <input
            value={savedTitle}
            aria-label="New clip name"
            onChange={(event) => setSavedTitle(event.target.value)}
            onBlur={() => {
              if (savedTitle.trim() && savedTitle.trim() !== (savedClip.title || "")) {
                void rename(savedClip.localId, savedTitle);
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
          <p className="muted">
            {formatDuration(savedClip.durationMs)} · The original file is unchanged.
            {savedKind === "short" ? " This file is 1080×1920." : ""}
          </p>
          {uploading ? <p className="muted">Uploading…</p> : null}
          {uploadStatus === "failed" ? <p className="muted">Upload failed. Retry from the player or library.</p> : null}
          {cloud?.status === "ready" ? (
            <label>
              Visibility
              <select
                value={cloud.visibility}
                aria-label="Clip visibility"
                onChange={(event) => void setVisibility(cloud.id, event.target.value as CloudClip["visibility"])}
              >
                <option value="private">Private — only you</option>
                <option value="unlisted">Unlisted — link only</option>
                <option value="public">Public — everyone</option>
              </select>
            </label>
          ) : null}
          <div className="row">
            <button type="button" className="btn" onClick={() => play(savedClip.localId)}>
              Watch
            </button>
            <button type="button" className="btn" onClick={() => void revealLocalClip(savedClip.filePath)}>
              Show in folder
            </button>
            <button type="button" className="btn" onClick={() => void download(savedClip.localId)}>
              Save a copy…
            </button>
            <button type="button" className="btn" disabled={sharingFile} onClick={() => void shareSavedFile()}>
              {sharingFile ? "Sharing…" : "Share file"}
            </button>
            <button type="button" className="btn" disabled={sharing || uploading} onClick={() => void shareSaved()}>
              {uploadStatus === "completed" ? "Copy Replayr link" : sharing || uploading ? "Uploading…" : "Replayr link"}
            </button>
            <Link className="btn" to="/library">
              Open in Library
            </Link>
          </div>
        </section>
      ) : null}
    </div>
  );
}
