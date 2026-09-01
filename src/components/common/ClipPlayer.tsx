import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { convertFileSrc } from "@tauri-apps/api/core";
import { SendClipSheet } from "./SendClipSheet";
import { PlayerVideo } from "./ReplayrWatermark";
import { useLibraryStore } from "../../stores/libraryStore";
import { useCloudStore } from "../../stores/cloudStore";
import { useAuthStore } from "../../stores/authStore";
import { useBillingStore } from "../../stores/billingStore";
import { formatBytes, formatClipDate, formatDuration, isVideoPath } from "../../utils/format";
import { clipWebcamSource, parseSourceLayout, webcamOverlayStyle } from "../../utils/clips";
import { prepareLocalClipPlayback } from "../../services/tauri";
import { useToastStore } from "../../stores/toastStore";
import { invokeErrorMessage } from "../../utils/format";

const MEDIA_ERR: Record<number, string> = {
  1: "ABORTED",
  2: "NETWORK",
  3: "DECODE",
  4: "SRC_NOT_SUPPORTED",
};

function playbackSrcKind(src: string): string {
  if (src.startsWith("asset:") || src.includes("asset.localhost")) return "asset";
  if (src.startsWith("http://") || src.startsWith("https://")) return "http";
  return "other";
}

function localPlayErrorMessage(videoEl: HTMLVideoElement): string {
  const code = videoEl.error?.code ?? 0;
  const kind = playbackSrcKind(videoEl.currentSrc || videoEl.src || "");
  return `Local play failed (${MEDIA_ERR[code] ?? `code ${code}`}, ${kind})`;
}

/** Webcam vs gameplay offset (seconds). Positive = delay cam. */
const WEBCAM_LAG_S = 0;

export function ClipPlayer() {
  const clips = useLibraryStore((state) => state.clips);
  const playingId = useLibraryStore((state) => state.playingId);
  const closePlayer = useLibraryStore((state) => state.closePlayer);
  const rename = useLibraryStore((state) => state.rename);
  const favorite = useLibraryStore((state) => state.favorite);
  const remove = useLibraryStore((state) => state.remove);
  const removeFromCloud = useLibraryStore((state) => state.removeFromCloud);
  const reveal = useLibraryStore((state) => state.reveal);
  const upload = useLibraryStore((state) => state.upload);
  const ensureCloudUpload = useLibraryStore((state) => state.ensureCloudUpload);
  const user = useAuthStore((state) => state.user);
  const watermark = useBillingStore((state) => state.status?.watermark ?? true);
  const cloudClips = useCloudStore((state) => state.clips);
  const navigate = useNavigate();
  const clip = clips.find((item) => item.localId === playingId) ?? null;
  const [title, setTitle] = useState(clip?.title ?? "");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [wrapFullscreen, setWrapFullscreen] = useState(false);
  const [playError, setPlayError] = useState<string | null>(null);
  const [playPath, setPlayPath] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const preparedRef = useRef(false);
  const gameplayRef = useRef<HTMLVideoElement>(null);
  const webcamRef = useRef<HTMLVideoElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setTitle(clip?.title ?? "");
    setConfirmDelete(false);
    setSendOpen(false);
    setSending(false);
    setPlayError(null);
    setPlayPath(null);
    setPreparing(false);
    preparedRef.current = false;
  }, [clip?.localId, clip?.title]);

  useEffect(() => {
    function onFullscreenChange() {
      setWrapFullscreen(document.fullscreenElement === wrapRef.current);
    }
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  useEffect(() => {
    if (!clip) return;
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      if (document.fullscreenElement) {
        void document.exitFullscreen().catch(() => undefined);
        return;
      }
      closePlayer();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [clip, closePlayer]);

  if (!clip) return null;

  const playbackFile = playPath ?? clip.filePath;
  const media = convertFileSrc(playbackFile);
  const video = isVideoPath(clip.filePath);
  const webcamSource = clipWebcamSource(clip);
  const webcamMedia = webcamSource ? convertFileSrc(webcamSource.filePath) : "";
  const webcamLayout = parseSourceLayout(webcamSource?.layoutJson);
  const uploading = ["queued", "preparing", "uploading", "processing"].includes(clip.uploadStatus);
  const cloudSlug = cloudClips.find((item) => item.id === clip.cloudClipId)?.slug;

  function syncWebcam(master: HTMLVideoElement) {
    const cam = webcamRef.current;
    if (!cam) return;
    // Webcam pipeline runs ~1s ahead of gameplay; delay cam to match audio/game.
    const target = Math.max(0, master.currentTime - WEBCAM_LAG_S);
    const drift = Math.abs(cam.currentTime - target);
    if (drift > 0.05) {
      cam.currentTime = target;
    }
    if (master.paused) {
      if (!cam.paused) cam.pause();
    } else if (cam.paused) {
      void cam.play().catch(() => undefined);
    }
  }

  async function recoverLocalPlay(videoEl: HTMLVideoElement) {
    const code = videoEl.error?.code ?? 0;
    const canRemux = (code === 3 || code === 4) && !preparedRef.current && !preparing;
    if (!canRemux) {
      const message = localPlayErrorMessage(videoEl);
      setPlayError(message);
      useToastStore.getState().showSticky(message, [{ label: "Dismiss", onClick: () => undefined }]);
      return;
    }
    preparedRef.current = true;
    setPreparing(true);
    setPlayError("Preparing clip for playback…");
    try {
      const next = await prepareLocalClipPlayback(clip.localId);
      if (next === playbackFile) {
        const message = localPlayErrorMessage(videoEl);
        setPlayError(message);
        useToastStore.getState().showSticky(message, [{ label: "Dismiss", onClick: () => undefined }]);
        return;
      }
      setPlayPath(next);
      setPlayError(null);
    } catch (caught) {
      const message = invokeErrorMessage(caught, localPlayErrorMessage(videoEl));
      setPlayError(message);
      useToastStore.getState().showSticky(message, [{ label: "Dismiss", onClick: () => undefined }]);
    } finally {
      setPreparing(false);
    }
  }

  async function toggleWrapFullscreen() {
    const wrap = wrapRef.current;
    if (!wrap) return;
    try {
      if (document.fullscreenElement === wrap) {
        await document.exitFullscreen();
      } else {
        await wrap.requestFullscreen();
      }
    } catch {
      /* WebView may deny fullscreen without a gesture */
    }
  }

  return (
    <div className="player-overlay" role="dialog" aria-modal="true" aria-label={clip.title || "Clip player"}>
      <button type="button" className="player-backdrop" aria-label="Close player" onClick={closePlayer} />
      <section className="player-card">
        <div className="player-stage">
          {video ? (
            <PlayerVideo ref={wrapRef} showWatermark={watermark}>
              <video
                key={media}
                ref={gameplayRef}
                src={media}
                controls
                autoPlay
                controlsList={webcamMedia ? "nofullscreen" : undefined}
                onPlay={(event) => syncWebcam(event.currentTarget)}
                onPause={(event) => syncWebcam(event.currentTarget)}
                onSeeked={(event) => syncWebcam(event.currentTarget)}
                onTimeUpdate={(event) => syncWebcam(event.currentTarget)}
                onError={(event) => {
                  void recoverLocalPlay(event.currentTarget);
                }}
                onDoubleClick={() => {
                  if (webcamMedia) void toggleWrapFullscreen();
                }}
              />
              {webcamMedia ? (
                <div
                  className={`editor-webcam place-${webcamLayout.placement} shape-${webcamLayout.shape}${webcamLayout.x != null && webcamLayout.y != null ? " free" : ""}`}
                  style={webcamOverlayStyle(webcamLayout)}
                >
                  <video
                    ref={webcamRef}
                    src={webcamMedia}
                    muted
                    playsInline
                    preload="auto"
                    controls={false}
                    onLoadedMetadata={(event) => {
                      const master = gameplayRef.current;
                      if (master) {
                        event.currentTarget.currentTime = Math.max(0, master.currentTime - WEBCAM_LAG_S);
                      }
                    }}
                  />
                </div>
              ) : null}
              {webcamMedia ? (
                <button
                  type="button"
                  className="player-fullscreen-btn"
                  aria-label={wrapFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
                  onClick={() => void toggleWrapFullscreen()}
                >
                  {wrapFullscreen ? "Exit full screen" : "Full screen"}
                </button>
              ) : null}
            </PlayerVideo>
          ) : (
            <img src={media} alt={clip.title || "Screenshot"} />
          )}
        </div>
        <div className="player-side">
          <input
            value={title}
            aria-label="Clip name"
            onChange={(event) => setTitle(event.target.value)}
            onBlur={() => {
              if (title.trim() && title.trim() !== (clip.title || "")) {
                void rename(clip.localId, title);
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.currentTarget.blur();
              }
            }}
          />
          <p className="muted">
            {formatClipDate(clip.createdAt)}
            {clip.durationMs ? ` · ${formatDuration(clip.durationMs)}` : ""}
            {clip.width && clip.height ? ` · ${clip.width}×${clip.height}` : ""}
            {clip.fileSize ? ` · ${formatBytes(clip.fileSize)}` : ""}
          </p>
          <p className="muted">{clip.filePath}</p>
          {playError ? <p className="error-text">{playError}</p> : null}
          <div className="row">
            <button type="button" className="btn" onClick={() => void favorite(clip.localId, !clip.favorite)}>
              {clip.favorite ? "Unfavorite" : "Favorite"}
            </button>
            <button type="button" className="btn" onClick={() => void reveal(clip.filePath)}>
              Show in folder
            </button>
          </div>
          {video ? (
            <button
              type="button"
              className="btn"
              onClick={() => {
                closePlayer();
                navigate(`/editor/${clip.localId}`);
              }}
            >
              Edit clip
            </button>
          ) : null}
          {video ? (
            user ? (
              <button
                type="button"
                className="btn primary"
                disabled={uploading || clip.uploadStatus === "completed"}
                onClick={() => void upload(clip.localId)}
              >
                {clip.uploadStatus === "completed"
                  ? "Uploaded"
                  : uploading
                    ? "Uploading…"
                    : clip.uploadStatus === "failed"
                      ? "Retry upload"
                      : "Upload to cloud"}
              </button>
            ) : (
              <Link className="btn primary" to="/profile">
                Sign in to upload
              </Link>
            )
          ) : null}
          {video && user ? (
            <button
              type="button"
              className="btn"
              disabled={sending || uploading}
              onClick={() => {
                void (async () => {
                  setSending(true);
                  try {
                    const ok = await ensureCloudUpload(clip.localId);
                    if (ok) setSendOpen(true);
                  } finally {
                    setSending(false);
                  }
                })();
              }}
            >
              {sending ? "Uploading…" : "Send"}
            </button>
          ) : null}
          {clip.cloudClipId && clip.uploadStatus === "completed" ? (
            <button
              type="button"
              className="btn"
              onClick={() => {
                if (
                  window.confirm(
                    "Remove this cloud copy? The file on this PC stays. The share link will stop working.",
                  )
                ) {
                  void removeFromCloud(clip.localId);
                }
              }}
            >
              Remove from cloud
            </button>
          ) : null}
          {confirmDelete ? (
            <div className="row">
              <button type="button" className="btn danger" onClick={() => void remove(clip.localId)}>
                {clip.cloudClipId ? "Delete from this PC and the cloud" : "Delete file"}
              </button>
              <button type="button" className="btn" onClick={() => setConfirmDelete(false)}>
                Cancel
              </button>
            </div>
          ) : (
            <button type="button" className="btn" onClick={() => setConfirmDelete(true)}>
              Delete
            </button>
          )}
          <button type="button" className="btn ghost" onClick={closePlayer}>
            Close
          </button>
        </div>
      </section>
      {sendOpen && cloudSlug ? <SendClipSheet slug={cloudSlug} onClose={() => setSendOpen(false)} /> : null}
    </div>
  );
}
