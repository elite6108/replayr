import { convertFileSrc } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { PageHeader } from "../components/common/PageHeader";
import { saveTrimmedClip } from "../services/tauri";
import { useAuthStore } from "../stores/authStore";
import { useCloudStore } from "../stores/cloudStore";
import { useLibraryStore } from "../stores/libraryStore";
import { useToastStore } from "../stores/toastStore";
import type { CloudClip, LocalClip } from "../types/clip";
import { formatClock, formatDuration, invokeErrorMessage, isVideoPath, parseClock } from "../utils/format";
import { normalizeUploadStatus } from "../utils/clips";

const MIN_TRIM_MS = 1000;

type DragKind = "start" | "end" | "playhead";

function asMs(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.round(value));
}

function clampRange(startMs: number, endMs: number, durationMs: number): { startMs: number; endMs: number } {
  const duration = Math.max(asMs(durationMs), MIN_TRIM_MS);
  const start = Math.max(0, Math.min(asMs(startMs), duration - MIN_TRIM_MS));
  const end = Math.max(start + MIN_TRIM_MS, Math.min(asMs(endMs), duration));
  return { startMs: start, endMs: end };
}

function filmstripCount(width: number): number {
  if (width <= 0) return 12;
  return Math.min(16, Math.max(8, Math.round(width / 90)));
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

function waitVideoEvent(video: HTMLVideoElement, event: string, timeoutMs = 4000): Promise<void> {
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

async function paintFilmstrip(
  video: HTMLVideoElement,
  canvases: Array<HTMLCanvasElement | null>,
  isCancelled: () => boolean,
): Promise<void> {
  const duration = video.duration;
  if (!Number.isFinite(duration) || duration <= 0 || video.videoWidth < 2) return;
  const saved = video.currentTime;
  const wasPaused = video.paused;
  video.pause();
  const tileW = 160;
  const tileH = Math.max(90, Math.round((video.videoHeight / video.videoWidth) * tileW));
  for (let index = 0; index < canvases.length; index += 1) {
    if (isCancelled()) return;
    video.currentTime = (duration * index) / Math.max(canvases.length, 1);
    await waitVideoEvent(video, "seeked").catch(() => undefined);
    await waitForVideoFrame(video);
    const canvas = canvases[index];
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) continue;
    canvas.width = tileW;
    canvas.height = tileH;
    ctx.drawImage(video, 0, 0, tileW, tileH);
  }
  if (isCancelled()) return;
  video.currentTime = saved;
  if (!wasPaused) void video.play();
}

export function EditorPage() {
  const { clipId } = useParams();
  const navigate = useNavigate();
  const clips = useLibraryStore((state) => state.clips);
  const loaded = useLibraryStore((state) => state.loaded);
  const closePlayer = useLibraryStore((state) => state.closePlayer);
  const play = useLibraryStore((state) => state.play);
  const rename = useLibraryStore((state) => state.rename);
  const upload = useLibraryStore((state) => state.upload);
  const copyLink = useLibraryStore((state) => state.copyLink);
  const refresh = useLibraryStore((state) => state.refresh);
  const user = useAuthStore((state) => state.user);
  const cloudClips = useCloudStore((state) => state.clips);
  const setVisibility = useCloudStore((state) => state.setVisibility);
  const showToast = useToastStore((state) => state.show);

  const source = clips.find((item) => item.localId === clipId) ?? null;
  const videoRef = useRef<HTMLVideoElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const stripCanvasRefs = useRef<Array<HTMLCanvasElement | null>>([]);
  const dragRef = useRef<DragKind | null>(null);

  const [videoMs, setVideoMs] = useState(0);
  const [startMs, setStartMs] = useState(0);
  const [endMs, setEndMs] = useState(0);
  const [playheadMs, setPlayheadMs] = useState(0);
  const [startText, setStartText] = useState("00:00");
  const [endText, setEndText] = useState("00:00");
  const [playing, setPlaying] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [saved, setSaved] = useState<LocalClip | null>(null);
  const [savedTitle, setSavedTitle] = useState("");
  const [stripTiles, setStripTiles] = useState(12);
  const [videoReady, setVideoReady] = useState(false);

  const durationMs = Math.max(source?.durationMs ?? 0, videoMs);
  const savedClip = clips.find((item) => item.localId === saved?.localId) ?? saved;
  const cloud = savedClip?.cloudClipId
    ? cloudClips.find((item) => item.id === savedClip.cloudClipId) ?? null
    : null;
  const uploadStatus = normalizeUploadStatus(savedClip?.uploadStatus);
  const uploading = ["queued", "preparing", "uploading", "processing"].includes(uploadStatus);

  useEffect(() => {
    closePlayer();
  }, [closePlayer]);

  useEffect(() => {
    if (!loaded) return;
    if (!source || !isVideoPath(source.filePath)) {
      navigate("/library", { replace: true });
    }
  }, [loaded, source, navigate]);

  useEffect(() => {
    if (!source) return;
    const duration = Math.max(source.durationMs ?? 0, MIN_TRIM_MS);
    setStartMs(0);
    setEndMs(duration);
    setPlayheadMs(0);
    setStartText(formatClock(0, true));
    setEndText(formatClock(duration, true));
    setSaved(null);
    setPreviewing(false);
    setVideoReady(false);
    const video = videoRef.current;
    if (video) {
      video.pause();
      video.currentTime = 0;
    }
  }, [source?.localId]);

  useEffect(() => {
    const node = timelineRef.current;
    if (!node) return;
    const apply = () => setStripTiles(filmstripCount(node.clientWidth));
    apply();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => apply());
    observer.observe(node);
    return () => observer.disconnect();
  }, [source?.localId]);

  useEffect(() => {
    if (!source || !videoReady) return;
    const video = videoRef.current;
    if (!video || video.videoWidth < 2) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void paintFilmstrip(video, stripCanvasRefs.current, () => cancelled);
    }, 80);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [source?.localId, videoReady, stripTiles]);

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
  }, [durationMs]);

  const msFromClientX = useCallback((clientX: number) => {
    const node = timelineRef.current;
    if (!node || durationMs <= 0) return 0;
    const rect = node.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return asMs(ratio * durationMs);
  }, [durationMs]);

  useEffect(() => {
    function onMove(event: PointerEvent) {
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
      dragRef.current = null;
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [applyRange, endMs, msFromClientX, seekTo, startMs]);

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
  const canSave = Boolean(source) && selectedMs >= MIN_TRIM_MS && !saving;

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
    videoRef.current?.pause();
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

  async function saveClip(share: boolean) {
    if (!source || saving) return;
    setSaving(true);
    try {
      const next = await saveTrimmedClip(source.localId, asMs(startMs), asMs(endMs));
      setSaved(next);
      setSavedTitle(next.title || "");
      await refresh();
      if (share) {
        if (!user) {
          showToast("Sign in to share");
          return;
        }
        setSharing(true);
        await upload(next.localId);
        await copyLink(next.localId);
      } else {
        showToast("Saved as a new clip");
      }
    } catch (caught) {
      showToast(invokeErrorMessage(caught, "Could not save that trim"));
    } finally {
      setSaving(false);
      setSharing(false);
    }
  }
  saveRef.current = saveClip;

  async function shareSaved() {
    if (!savedClip) return;
    if (!user) {
      showToast("Sign in to share");
      return;
    }
    setSharing(true);
    try {
      if (uploadStatus !== "completed") {
        await upload(savedClip.localId);
      }
      await copyLink(savedClip.localId);
    } finally {
      setSharing(false);
    }
  }

  const media = useMemo(() => (source ? convertFileSrc(source.filePath) : ""), [source]);

  if (!source) {
    return <p className="muted">Loading clip…</p>;
  }

  return (
    <div className="editor-layout">
      <PageHeader title={source.title || "Untitled clip"} subtitle="Trim a new local MP4. The original file stays unchanged.">
        <Link className="btn" to="/library" onClick={() => closePlayer()}>
          Back
        </Link>
      </PageHeader>

      <div className="editor-stage player-stage">
        <video
          ref={videoRef}
          src={media}
          controls={false}
          onClick={togglePlay}
          onLoadedMetadata={(event) => {
            const next = asMs(event.currentTarget.duration * 1000);
            if (next > 0) {
              setVideoMs(next);
              if ((source.durationMs ?? 0) <= 0) {
                applyRange(0, next);
              }
            }
            setVideoReady(true);
          }}
          onTimeUpdate={(event) => {
            const ms = asMs(event.currentTarget.currentTime * 1000);
            setPlayheadMs(ms);
            if (previewing && ms >= endMs) {
              event.currentTarget.pause();
              event.currentTarget.currentTime = endMs / 1000;
              setPlayheadMs(asMs(endMs));
              setPreviewing(false);
            }
          }}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
        />
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
          {Array.from({ length: stripTiles }, (_, index) => (
            <canvas
              key={index}
              ref={(node) => {
                stripCanvasRefs.current[index] = node;
              }}
            />
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

      <p className="muted editor-hint">
        Start may snap back by up to about 2 seconds to the previous keyframe. Space plays, I / O set in and out, arrows
        nudge 1s (Shift 5s).
      </p>

      <div className="row">
        <button type="button" className="btn" onClick={resetRange}>
          Reset
        </button>
        <button type="button" className="btn" onClick={previewSelection}>
          {playing && previewing ? "Previewing…" : "Preview Selection"}
        </button>
        <button type="button" className="btn primary" disabled={!canSave} onClick={() => void saveClip(false)}>
          {saving && !sharing ? "Saving…" : "Save as New Clip"}
        </button>
        <button type="button" className="btn primary" disabled={!canSave} onClick={() => void saveClip(true)}>
          {sharing ? "Sharing…" : "Save & Share"}
        </button>
      </div>

      {savedClip ? (
        <section className="panel stack editor-success">
          <h2>New clip saved</h2>
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
          <p className="muted">{formatDuration(savedClip.durationMs)} · The original file is unchanged.</p>
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
                <option value="unlisted">Unlisted</option>
                <option value="public">Public</option>
                <option value="private">Private</option>
              </select>
            </label>
          ) : null}
          <div className="row">
            <button type="button" className="btn" onClick={() => play(savedClip.localId)}>
              Watch
            </button>
            <button type="button" className="btn primary" disabled={sharing || uploading} onClick={() => void shareSaved()}>
              {uploadStatus === "completed" ? "Copy link" : sharing || uploading ? "Uploading…" : "Share"}
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
