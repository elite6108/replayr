import { Link } from "react-router-dom";
import { convertFileSrc } from "@tauri-apps/api/core";
import arrowIcon from "../../assets/figma/home/arrow-sm.svg";
import cameraIcon from "../../assets/figma/home/camera.svg";
import clipsIcon from "../../assets/figma/home/clips.svg";
import cloudCheckIcon from "../../assets/figma/home/cloud-check.svg";
import dateDot from "../../assets/figma/home/dot.svg";
import recordIcon from "../../assets/figma/home/record.svg";
import type { LocalClip } from "../../types/clip";
import { useDetectionStore } from "../../stores/detectionStore";
import { formatClipDate, formatDuration } from "../../utils/format";
import { IconMonitor } from "../icons";

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

export function LastSessionCard({
  clip,
  clipCount,
  screenshotCount,
  recordingCount,
  playedMs,
}: {
  clip: LocalClip | null;
  clipCount: number;
  screenshotCount: number;
  recordingCount: number;
  playedMs: number;
}) {
  const catalog = useDetectionStore((state) => state.catalog);
  const game = clip ? catalog.find((item) => item.slug === clip.gameId || item.cloudId === clip.gameId) : undefined;
  const thumb = clip?.thumbnailPath;
  const title = game?.name || clip?.title || "Last session";
  const played = playedLabel(playedMs);

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
              {played ? (
                <>
                  <span>{played} played</span>
                  <img className="asset" src={dateDot} alt="" draggable={false} />
                  <span>Nothing left behind.</span>
                </>
              ) : (
                "Nothing left behind."
              )}
            </p>
            <p className="last-session-stats">
              <span>
                <img className="asset" src={clipsIcon} alt="" draggable={false} />
                <strong>{clipCount}</strong> {clipCount === 1 ? "clip" : "clips"}
              </span>
              <span>
                <img className="asset" src={cameraIcon} alt="" draggable={false} />
                <strong>{screenshotCount}</strong> {screenshotCount === 1 ? "screenshot" : "screenshots"}
              </span>
              <span>
                <img className="asset" src={recordIcon} alt="" draggable={false} />
                <strong>{recordingCount}</strong> {recordingCount === 1 ? "recording" : "recordings"}
              </span>
            </p>
          </div>
          <div className="last-session-actions">
            <span className={`last-session-sync ${clip.cloudClipId ? "ok" : ""}`}>
              {clip.cloudClipId ? <img className="asset" src={cloudCheckIcon} alt="" draggable={false} /> : <IconMonitor size={13} />}
              {clip.cloudClipId ? "Cloud sync complete" : "Saved on this PC"}
            </span>
            <span className="last-session-open">
              Open session
              <img className="asset" src={arrowIcon} alt="" draggable={false} />
            </span>
          </div>
        </Link>
      ) : (
        <div className="home-dash-inner">
          <p className="muted last-session-empty">No session yet. Capture a clip and it will land here.</p>
        </div>
      )}
    </article>
  );
}
