import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { convertFileSrc } from "@tauri-apps/api/core";
import { SendClipSheet } from "./SendClipSheet";
import { PlayerVideo } from "./ReplayrWatermark";
import { useLibraryStore } from "../../stores/libraryStore";
import { useCloudStore } from "../../stores/cloudStore";
import { useAuthStore } from "../../stores/authStore";
import { useBillingStore } from "../../stores/billingStore";
import { formatBytes, formatClipDate, formatDuration, isVideoPath } from "../../utils/format";

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
  const user = useAuthStore((state) => state.user);
  const watermark = useBillingStore((state) => state.status?.watermark ?? true);
  const cloudClips = useCloudStore((state) => state.clips);
  const navigate = useNavigate();
  const clip = clips.find((item) => item.localId === playingId) ?? null;
  const [title, setTitle] = useState(clip?.title ?? "");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);

  useEffect(() => {
    setTitle(clip?.title ?? "");
    setConfirmDelete(false);
    setSendOpen(false);
  }, [clip?.localId, clip?.title]);

  useEffect(() => {
    if (!clip) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") closePlayer();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [clip, closePlayer]);

  if (!clip) return null;

  const media = convertFileSrc(clip.filePath);
  const video = isVideoPath(clip.filePath);
  const uploading = ["queued", "preparing", "uploading", "processing"].includes(clip.uploadStatus);
  const cloudSlug = cloudClips.find((item) => item.id === clip.cloudClipId)?.slug;

  return (
    <div className="player-overlay" role="dialog" aria-modal="true" aria-label={clip.title || "Clip player"}>
      <button type="button" className="player-backdrop" aria-label="Close player" onClick={closePlayer} />
      <section className="player-card">
        <div className="player-stage">
          {video ? (
            <PlayerVideo showWatermark={watermark}>
              <video src={media} controls autoPlay />
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
          {cloudSlug && user ? (
            <button type="button" className="btn" onClick={() => setSendOpen(true)}>
              Send
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
