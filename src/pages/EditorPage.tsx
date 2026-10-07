import { convertFileSrc } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { CaretDown, CornersOut, Pause, Play, SkipBack, SkipForward, SpeakerHigh, SpeakerSlash } from "@phosphor-icons/react";
import { EditorHeader } from "../components/editor/EditorHeader";
import { EditorInspector } from "../components/editor/EditorInspector";
import { EditorTimeline } from "../components/editor/EditorTimeline";
import {
  clampSegmentEdge,
  clampViewStart,
  clampZoom,
  mergeWithNext,
  nextSegmentAfter,
  outerRange,
  removeSegment,
  segmentAt,
  segmentsToRanges,
  setOuterRange,
  singleSegment,
  splitAt,
  timelineMap,
  totalMs,
  viewSpanMs,
  zoomAround,
  type Segment,
  type SegmentEdge,
  type TimelineMap,
} from "../components/editor/segments";
import {
  getClipWaveform,
  listClipFilmstrip,
  revealLocalClip,
  saveSegmentedClip,
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

/** Edge drags keep the map captured at pointer-down so the seam under the cursor does not move mid-drag. */
type DragKind = "playhead" | { segmentId: string; edge: SegmentEdge; map: TimelineMap };
type SaveKind = "trim" | "short" | "sections";

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
  const [segments, setSegments] = useState<Segment[]>(() => singleSegment(0, MIN_TRIM_MS));
  const [selectedSegmentId, setSelectedSegmentId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [viewStartMs, setViewStartMs] = useState(0);
  const [playheadMs, setPlayheadMs] = useState(0);
  const [startText, setStartText] = useState("00:00");
  const [endText, setEndText] = useState("00:00");
  const [playing, setPlaying] = useState(false);
  const [previewVolume, setPreviewVolume] = useState(1);
  const [previewFit, setPreviewFit] = useState<"contain" | "cover">("contain");
  const [previewing, setPreviewing] = useState(false);
  const [savingKind, setSavingKind] = useState<SaveKind | null>(null);
  const [sharing, setSharing] = useState(false);
  const [sharingFile, setSharingFile] = useState(false);
  const [saved, setSaved] = useState<LocalClip | null>(null);
  const [savedKind, setSavedKind] = useState<SaveKind | null>(null);
  const [savedTitle, setSavedTitle] = useState("");
  const [stripFrames, setStripFrames] = useState<Array<{ path: string; atMs: number }>>([]);
  const [wavePeaks, setWavePeaks] = useState<number[] | null>(null);
  const [pan, setPan] = useState(0.5);
  const [shortsMode, setShortsMode] = useState(false);
  const [webcamLayout, setWebcamLayout] = useState<ClipSourceLayout>(() => parseSourceLayout(null));

  panRef.current = pan;
  // Edge drags read the latest segments without waiting for a re-render.
  const segmentsRef = useRef(segments);
  segmentsRef.current = segments;
  const webcamLayoutRef = useRef(webcamLayout);
  webcamLayoutRef.current = webcamLayout;
  const saving = savingKind !== null;
  const durationMs = Math.max(source?.durationMs ?? 0, videoMs);
  const { startMs, endMs } = outerRange(segments);
  const multiSection = segments.length > 1;
  const tl = useMemo(() => timelineMap(segments, durationMs), [segments, durationMs]);
  const tlRef = useRef(tl);
  tlRef.current = tl;
  const viewDomain = Math.max(tl.domainMs, MIN_TRIM_MS);
  const viewSpan = viewSpanMs(viewDomain, zoom);
  const viewStart = clampViewStart(viewStartMs, viewDomain, zoom);
  const viewEnd = viewStart + viewSpan;
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
    setSegments(singleSegment(0, duration));
    setSelectedSegmentId(null);
    setZoom(1);
    setViewStartMs(0);
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
      setSegments(singleSegment(next.startMs, next.endMs));
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
      setWavePeaks([]);
      return;
    }
    let cancelled = false;
    setStripFrames([]);
    setWavePeaks(null);
    void (async () => {
      const frames = await listClipFilmstrip(source.localId, STRIP_TILES);
      if (!cancelled) setStripFrames(frames);
    })();
    void (async () => {
      const peaks = await getClipWaveform(source.localId);
      if (!cancelled) setWavePeaks(peaks);
    })();
    return () => {
      cancelled = true;
    };
  }, [folderSession, localSource, source?.localId]);

  const applyRange = useCallback(
    (nextStart: number, nextEnd: number) => {
      const next = clampRange(nextStart, nextEnd, durationMs);
      setSegments((prev) => setOuterRange(prev, next.startMs, next.endMs, MIN_TRIM_MS, durationMs));
      setStartText(formatClock(next.startMs, true));
      setEndText(formatClock(next.endMs, true));
      return next;
    },
    [durationMs],
  );

  // Keep the In/Out text in step when sections change the outer range (split, delete, join).
  useEffect(() => {
    setStartText(formatClock(startMs, true));
    setEndText(formatClock(endMs, true));
  }, [startMs, endMs]);

  const zoomTo = useCallback(
    (nextZoom: number, anchorMs: number, anchorFrac: number) => {
      const clamped = clampZoom(nextZoom);
      setZoom(clamped);
      setViewStartMs(zoomAround(anchorMs, anchorFrac, viewDomain, clamped));
    },
    [viewDomain],
  );

  const scrollView = useCallback(
    (nextViewStartMs: number) => {
      setViewStartMs(clampViewStart(nextViewStartMs, viewDomain, zoom));
    },
    [viewDomain, zoom],
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

  /** Pointer x -> source ms. `map` defaults to the live timeline map; drags pass a frozen one. */
  const msFromClientX = useCallback(
    (clientX: number, map: TimelineMap = tlRef.current) => {
      const node = timelineRef.current;
      if (!node || durationMs <= 0) return 0;
      const rect = node.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      return asMs(map.toSource(viewStart + ratio * viewSpan));
    },
    [durationMs, viewStart, viewSpan],
  );

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
      if (kind === "playhead") {
        videoRef.current?.pause();
        seekTo(msFromClientX(event.clientX));
        return;
      }
      const at = msFromClientX(event.clientX, kind.map);
      const result = clampSegmentEdge(segmentsRef.current, kind.segmentId, kind.edge, at, MIN_TRIM_MS, durationMs);
      segmentsRef.current = result.segments;
      setSegments(result.segments);
      seekTo(result.ms);
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
  }, [durationMs, msFromClientX, overlay.visible, overlay.width, persistPan, persistWebcamLayout, seekTo]);

  const saveRef = useRef<(share: boolean) => Promise<void>>(async () => {});
  const togglePlayRef = useRef<() => void>(() => {});
  const sectionActionsRef = useRef<{ split: () => void; remove: () => void }>({ split: () => {}, remove: () => {} });
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
        return;
      }
      if ((event.key === "s" || event.key === "S") && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        sectionActionsRef.current.split();
        return;
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        sectionActionsRef.current.remove();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [applyRange, seekTo]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = previewVolume;
    video.muted = previewVolume === 0;
  }, [previewVolume, source?.localId]);

  const selectedMs = multiSection ? totalMs(segments) : Math.max(0, endMs - startMs);
  const canSave =
    Boolean(source) &&
    selectedMs >= MIN_TRIM_MS &&
    !saving &&
    (!folderSession || folderSession.permissions.modifyEdits);
  const longShort = selectedMs > SHORTS_WARN_MS;
  // Sections only export through the local multi-range path.
  const sectionsAllowed = Boolean(localSource) && !folderSession;

  function splitAtPlayhead() {
    if (!sectionsAllowed) {
      showToast("Sections are available for local clips only.");
      return;
    }
    const next = splitAt(segments, playheadMs, MIN_TRIM_MS);
    if (next === segments) {
      showToast("Move the playhead inside a section, at least one second from its edges.");
      return;
    }
    setSegments(next);
    setShortsMode(false);
    const created = segmentAt(next, playheadMs);
    setSelectedSegmentId(created?.id ?? null);
  }

  function deleteSelectedSection() {
    if (!selectedSegmentId) return;
    const next = removeSegment(segments, selectedSegmentId);
    if (next === segments) return;
    setSegments(next);
    setSelectedSegmentId(null);
  }

  function joinSelectedSection() {
    if (!selectedSegmentId) return;
    setSegments((prev) => mergeWithNext(prev, selectedSegmentId));
  }
  sectionActionsRef.current = { split: splitAtPlayhead, remove: deleteSelectedSection };

  /** During preview, jump over removed sections and stop at the last kept one. */
  function followPreview(video: HTMLVideoElement, ms: number) {
    if (segmentAt(segments, ms)) {
      if (ms >= endMs) {
        video.pause();
        video.currentTime = endMs / 1000;
        setPlayheadMs(asMs(endMs));
        setPreviewing(false);
      }
      return;
    }
    const next = nextSegmentAfter(segments, ms);
    if (next) {
      video.currentTime = next.startMs / 1000;
      setPlayheadMs(next.startMs);
      return;
    }
    video.pause();
    video.currentTime = endMs / 1000;
    setPlayheadMs(asMs(endMs));
    setPreviewing(false);
  }

  /** Keeps the playhead visible while zoomed in and playing. */
  function followPlayhead(ms: number) {
    if (zoom <= 1) return;
    const at = tl.toTimeline(ms);
    if (at < viewStart || at > viewEnd) {
      setViewStartMs(clampViewStart(at - viewSpan * 0.1, viewDomain, zoom));
    }
  }

  function stepFrame(direction: -1 | 1) {
    const fps = source?.fps;
    const frameMs = fps != null && fps > 1 ? 1000 / fps : 33;
    seekTo(tl.toSource(tl.toTimeline(playheadMs) + direction * frameMs));
  }

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
    setSegments(singleSegment(0, Math.max(durationMs, MIN_TRIM_MS)));
    setSelectedSegmentId(null);
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
    if (kind === "sections" && !multiSection) kind = "trim";
    if (kind === "short" && multiSection) {
      showToast("Shorts save a single section. Join the sections first.");
      return;
    }
    setSavingKind(kind);
    try {
      const next =
        kind === "short"
          ? await saveShortClip(source.localId, asMs(startMs), asMs(endMs), pan)
          : kind === "sections"
            ? await saveSegmentedClip(source.localId, segmentsToRanges(segments))
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
        showToast(
          kind === "short"
            ? "Saved as a Short"
            : kind === "sections"
              ? `Saved ${segments.length} sections as a new clip`
              : "Saved as a new clip",
        );
      }
    } catch (caught) {
      const message = invokeErrorMessage(
        caught,
        kind === "short" ? "Could not save that Short" : kind === "sections" ? "Could not save those sections" : "Could not save that trim",
      );
      showToast(message);
      trackClipSaveFailed(message);
      if (kind === "short") trackClipRenderFailed({ kind: "short", message });
    } finally {
      setSavingKind(null);
      setSharing(false);
    }
  }
  saveRef.current = (share) => saveClip(multiSection ? "sections" : shortsMode ? "short" : "trim", share);

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

  const frameWidth = frameSize.width || source.width || 0;
  const frameHeight = frameSize.height || source.height || 0;
  const sourceIs16x9 =
    frameWidth > 0 && frameHeight > 0 && Math.abs(frameWidth / frameHeight - 16 / 9) / (16 / 9) < 0.03;
  return (
    <div
      className="editor-studio"
      style={
        frameSize.width > 0 && frameSize.height > 0
          ? ({ "--editor-aspect": frameSize.width / frameSize.height } as CSSProperties)
          : undefined
      }
    >
      <EditorHeader
        title={folderSession ? folderSession.editName : source.title || "Untitled clip"}
        meta={`${formatDuration(durationMs)} · ${source.width} × ${source.height}${source.fps ? ` · ${source.fps} FPS` : ""}`}
        backTo={folderSession ? `/library/folders/${folderSession.folderId}` : "/library"}
        onBack={() => closePlayer()}
        badge={folderSession ? "Shared Edit" : undefined}
        saving={saving}
        menu={
          <>
            <button
              type="button"
              role="menuitem"
              disabled={!canSave}
              onClick={() => void saveClip(multiSection ? "sections" : shortsMode ? "short" : "trim", false)}
            >
              {folderSession
                ? "Save Folder Edit"
                : multiSection
                  ? `Save as New Clip (${segments.length} sections)`
                  : "Save as New Clip"}
            </button>
            {folderSession || multiSection ? null : (
              <button type="button" role="menuitem" onClick={() => setShortsMode(true)}>
                Export / Share
              </button>
            )}
            {folderSession && localSource ? (
              <button
                type="button"
                role="menuitem"
                disabled={!canSave || !folderSession.permissions.renderEdits}
                onClick={() => void saveEditedCopy()}
              >
                Save Edited Copy
              </button>
            ) : null}
            {savedClip ? (
              <>
                <button type="button" role="menuitem" onClick={() => play(savedClip.localId)}>
                  Watch saved clip
                </button>
                <button type="button" role="menuitem" onClick={() => void revealLocalClip(savedClip.filePath)}>
                  Show in folder
                </button>
                <button type="button" role="menuitem" onClick={() => void download(savedClip.localId)}>
                  Save a copy…
                </button>
                <button type="button" role="menuitem" disabled={sharingFile} onClick={() => void shareSavedFile()}>
                  {sharingFile ? "Sharing…" : "Share file"}
                </button>
                <button type="button" role="menuitem" disabled={sharing || uploading} onClick={() => void shareSaved()}>
                  {uploadStatus === "completed" ? "Copy Replayr link" : sharing || uploading ? "Uploading…" : "Replayr link"}
                </button>
              </>
            ) : null}
          </>
        }
      />

      <div className="editor-workspace">
      <div className="editor-main">

      <div className="editor-stage">
        <div className="editor-preview-stack">
        <div className="editor-preview-frame">
        <div ref={previewRef} className={`editor-preview fit-${previewFit}`}>
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
              video.volume = previewVolume;
              video.muted = previewVolume === 0;
              void ensureFirstFrame(video);
            }}
            onTimeUpdate={(event) => {
              const video = event.currentTarget;
              const ms = asMs(video.currentTime * 1000);
              setPlayheadMs(ms);
              syncWebcam(video);
              followPlayhead(ms);
              if (previewing || tl.collapsed) followPreview(video, ms);
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
        <div className="editor-playback">
          <span className="editor-timecode">
            <strong>{formatClock(tl.collapsed ? tl.toTimeline(playheadMs) : playheadMs, true)}</strong>
            <span>/ {formatClock(tl.collapsed ? tl.domainMs : durationMs, true)}</span>
          </span>
          <div className="editor-transport">
            <button type="button" onClick={() => stepFrame(-1)} aria-label="Previous frame">
              <SkipBack size={16} weight="fill" />
            </button>
            <button type="button" className="editor-play" onClick={togglePlay} aria-label={playing ? "Pause" : "Play"}>
              {playing ? <Pause size={18} weight="fill" /> : <Play size={18} weight="fill" />}
            </button>
            <button type="button" onClick={() => stepFrame(1)} aria-label="Next frame">
              <SkipForward size={16} weight="fill" />
            </button>
          </div>
          <div className="editor-volume">
            <label className="editor-volume-slider">
              {previewVolume === 0 ? <SpeakerSlash size={15} /> : <SpeakerHigh size={15} />}
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={previewVolume}
                aria-label="Preview volume"
                onChange={(event) => setPreviewVolume(Number(event.target.value))}
              />
            </label>
            <button
              type="button"
              aria-label="Fullscreen preview"
              title="Fullscreen"
              onClick={() => void previewRef.current?.requestFullscreen?.()}
            >
              <CornersOut size={15} />
            </button>
            <button
              type="button"
              className="editor-fit"
              title={previewFit === "contain" ? "Fit: whole frame" : "Fit: fill"}
              onClick={() => setPreviewFit((value) => (value === "contain" ? "cover" : "contain"))}
            >
              {previewFit === "contain" ? "Fit" : "Fill"}
              <CaretDown size={10} />
            </button>
          </div>
        </div>
        </div>
      </div>

      </div>

      <EditorInspector
        source={source}
        shortsMode={shortsMode}
        sourceIs16x9={sourceIs16x9}
        pan={pan}
        overlayVisible={shortsMode && overlay.visible}
        onShortsMode={setShortsMode}
        sections={multiSection ? { count: segments.length } : null}
        onPan={(value) => {
          const next = clampPan(value);
          panRef.current = next;
          setPan(next);
        }}
        onPersistPan={() => persistPan(panRef.current)}
        onResetPan={() => {
          panRef.current = 0.5;
          setPan(0.5);
          persistPan(0.5);
        }}
        longSelection={longShort && shortsMode}
        webcam={
          webcamMedia
            ? {
                layout: webcamLayout,
                placements: WEBCAM_PLACEMENTS,
                shapes: WEBCAM_SHAPES,
                onPlacement: (id) => persistWebcamLayout({ ...webcamLayout, placement: id, x: null, y: null }),
                onShape: (id) => persistWebcamLayout({ ...webcamLayout, shape: id }),
                onWidth: (percent) => persistWebcamLayout({ ...webcamLayout, width: percent / 100 }),
              }
            : null
        }
      />
      </div>

      <EditorTimeline
        timelineRef={timelineRef}
        durationMs={durationMs}
        segments={segments}
        map={tl}
        selectedSegmentId={selectedSegmentId}
        startMs={startMs}
        endMs={endMs}
        startText={startText}
        endText={endText}
        playheadMs={playheadMs}
        viewStartMs={viewStart}
        viewEndMs={viewEnd}
        zoom={zoom}
        frames={stripFrames.map((frame) => convertFileSrc(frame.path))}
        peaks={wavePeaks}
        onPointerDown={(event) => {
          if ((event.target as HTMLElement).dataset.handle) return;
          if (!(event.target as HTMLElement).dataset.segment) setSelectedSegmentId(null);
          dragRef.current = "playhead";
          videoRef.current?.pause();
          seekTo(msFromClientX(event.clientX));
        }}
        onHandlePointerDown={(segmentId, edge) => {
          dragRef.current = { segmentId, edge, map: tl };
        }}
        onJoinSeam={(beforeId) => setSegments((prev) => mergeWithNext(prev, beforeId))}
        onPlayheadPointerDown={() => {
          dragRef.current = "playhead";
          videoRef.current?.pause();
        }}
        onSelectSegment={setSelectedSegmentId}
        onSplit={splitAtPlayhead}
        onDeleteSelected={deleteSelectedSection}
        onJoinSelected={joinSelectedSection}
        onStartText={setStartText}
        onEndText={setEndText}
        onCommitClock={commitClock}
        onReset={resetRange}
        onPreviewSelection={previewSelection}
        onZoom={zoomTo}
        onScroll={scrollView}
      />

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
