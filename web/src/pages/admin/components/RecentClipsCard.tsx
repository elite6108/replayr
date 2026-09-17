import { Link } from "react-router-dom";
import type { AdminClipRow } from "../../../lib/admin";
import { formatDurationMs } from "../../../lib/format";
import { formatRelativeTime } from "./adminFormat";

export function RecentClipsCard({ clips, loading, error }: { clips: AdminClipRow[]; loading: boolean; error: string | null }) {
  return (
    <section className="admin-panel">
      <header className="admin-panel-head">
        <h3>Recent Clips</h3>
        <Link to="/admin/clips">View all</Link>
      </header>
      {error ? <p className="error">{error}</p> : null}
      {loading ? <p className="muted">Loading clips…</p> : null}
      {!loading && !error && clips.length === 0 ? <p className="muted">No recent clips.</p> : null}
      <ul className="admin-clip-list">
        {clips.map((clip) => (
          <li key={clip.id}>
            <Link to={clip.sharePath} className="admin-clip-row">
              <span className="admin-clip-thumb" aria-hidden="true" />
              <span>
                <strong>{clip.title || "Untitled clip"}</strong>
                <small>
                  {clip.ownerUsername ? `@${clip.ownerUsername}` : clip.ownerEmail || "Unknown"}
                  {clip.durationMs != null ? ` · ${formatDurationMs(clip.durationMs)}` : ""}
                </small>
              </span>
              <em>{formatRelativeTime(clip.createdAt)}</em>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
