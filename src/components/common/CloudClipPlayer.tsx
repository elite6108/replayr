import { useEffect, useState } from "react";
import { DeleteClipDialog, type DeleteClipScope } from "./DeleteClipDialog";
import { PlayerVideo } from "./ReplayrWatermark";
import { useBillingStore } from "../../stores/billingStore";
import { useCloudStore } from "../../stores/cloudStore";
import { useLibraryStore } from "../../stores/libraryStore";
import { formatBytes, formatClipDate, formatDuration } from "../../utils/format";

export function CloudClipPlayer() {
  const playing = useCloudStore((state) => state.playing);
  const closePlayer = useCloudStore((state) => state.closePlayer);
  const rename = useCloudStore((state) => state.rename);
  const removeBoth = useCloudStore((state) => state.remove);
  const unlink = useCloudStore((state) => state.unlink);
  const download = useCloudStore((state) => state.download);
  const copyLink = useCloudStore((state) => state.copyLink);
  const setVisibility = useCloudStore((state) => state.setVisibility);
  const clips = useLibraryStore((state) => state.clips);
  const removeLocalOnly = useLibraryStore((state) => state.removeLocal);
  const watermark = useBillingStore((state) => state.status?.watermark ?? true);
  const [title, setTitle] = useState(playing?.clip.title ?? "");
  const [deleteOpen, setDeleteOpen] = useState(false);

  useEffect(() => {
    setTitle(playing?.clip.title ?? "");
    setDeleteOpen(false);
  }, [playing?.clip.id, playing?.clip.title]);

  useEffect(() => {
    if (!playing) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") closePlayer();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [playing, closePlayer]);

  if (!playing) return null;

  const { clip, url } = playing;
  const linkedLocal = clips.find((item) => item.cloudClipId === clip.id) ?? null;

  return (
    <div className="player-overlay" role="dialog" aria-modal="true" aria-label={clip.title || "Cloud clip"}>
      <button type="button" className="player-backdrop" aria-label="Close player" onClick={closePlayer} />
      <section className="player-card">
        <div className="player-stage">
          <PlayerVideo showWatermark={watermark}>
            <video src={url} controls autoPlay />
          </PlayerVideo>
        </div>
        <div className="player-side">
          <input
            value={title}
            aria-label="Clip name"
            onChange={(event) => setTitle(event.target.value)}
            onBlur={() => {
              if (title.trim() && title.trim() !== (clip.title || "")) {
                void rename(clip.id, title);
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
          <p className="muted">
            {formatClipDate(clip.createdAt)}
            {clip.durationMs ? ` · ${formatDuration(clip.durationMs)}` : ""}
            {clip.width && clip.height ? ` · ${clip.width}×${clip.height}` : ""}
            {clip.fileSizeBytes ? ` · ${formatBytes(clip.fileSizeBytes)}` : ""}
          </p>
          <label>
            Visibility
            <select
              value={clip.visibility}
              aria-label="Clip visibility"
              disabled={clip.status !== "ready"}
              onChange={(event) =>
                void setVisibility(clip.id, event.target.value as typeof clip.visibility)
              }
            >
              <option value="private">Private — only you</option>
              <option value="unlisted">Unlisted — link only</option>
              <option value="public">Public — everyone</option>
            </select>
          </label>
          <div className="row">
            <button type="button" className="btn" disabled={clip.status !== "ready"} onClick={() => void download(clip.id)}>
              Download
            </button>
            <button
              type="button"
              className="btn"
              disabled={clip.status !== "ready" || clip.visibility === "private"}
              title={clip.visibility === "private" ? "Private clips have no share link" : "Copy share link"}
              onClick={() => void copyLink(clip.id)}
            >
              Copy link
            </button>
          </div>
          <button type="button" className="btn" onClick={() => setDeleteOpen(true)}>
            Delete
          </button>
          <button type="button" className="btn ghost" onClick={closePlayer}>
            Close
          </button>
        </div>
      </section>
      {deleteOpen ? (
        <DeleteClipDialog
          showPc={Boolean(linkedLocal)}
          showCloud
          showBoth={Boolean(linkedLocal)}
          onClose={() => setDeleteOpen(false)}
          onChoose={(scope: DeleteClipScope) => {
            setDeleteOpen(false);
            if (scope === "pc" && linkedLocal) {
              void removeLocalOnly(linkedLocal.localId);
              return;
            }
            if (scope === "cloud") {
              closePlayer();
              void unlink(clip.id);
              return;
            }
            closePlayer();
            void removeBoth(clip.id);
          }}
        />
      ) : null}
    </div>
  );
}
