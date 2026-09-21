import { Link } from "react-router-dom";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { LocalClip } from "../../types/clip";
import { useDetectionStore } from "../../stores/detectionStore";
import { formatClipDate, formatDuration } from "../../utils/format";

function playedLabel(ms: number | null | undefined) {
  if (!ms) return null;
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest ? `${hours}h ${rest}m` : `${hours}h`;
  }
  if (minutes > 0) return `${minutes}m`;
  return formatDuration(ms);
}

export function LastSessionCard({ clip }: { clip: LocalClip | null }) {
  const catalog = useDetectionStore((state) => state.catalog);
  const game = clip ? catalog.find((item) => item.slug === clip.gameId || item.cloudId === clip.gameId) : undefined;
  const thumb = clip?.thumbnailPath;
  const title = game?.name || clip?.title || "Last session";
  const played = clip ? playedLabel(clip.durationMs) : null;
  const detail = clip && clip.title && clip.title !== title ? clip.title : null;

  return (
    <article className="home-dash-card last-session-card">
      <div className="home-dash-head">
        <h2>Last session</h2>
        {clip ? <span className="muted">{formatClipDate(clip.createdAt)}</span> : null}
      </div>
      {clip ? (
        <Link className="home-dash-inner last-session-body" to="/library">
          {thumb ? <img src={convertFileSrc(thumb)} alt="" /> : <div className="last-session-empty-art" />}
          <div className="last-session-copy">
            <strong>{title}</strong>
            <p className="muted">
              {[played ? `${played} played` : null, detail].filter(Boolean).join(" · ") || "Saved on this PC"}
            </p>
          </div>
          <span className={`last-session-sync ${clip.cloudClipId ? "ok" : ""}`}>
            <span className="pip on" />
            {clip.cloudClipId ? "Cloud sync complete" : "This PC"}
          </span>
        </Link>
      ) : (
        <div className="home-dash-inner">
          <p className="muted last-session-empty">No session yet. Capture a clip and it will land here.</p>
        </div>
      )}
    </article>
  );
}
