import { formatBytes } from "../../../lib/format";

export function StorageUsageCard({ bytes }: { bytes: number | null }) {
  const used = bytes ?? 0;
  return (
    <section className="admin-panel admin-storage-card">
      <header>
        <h3>Storage Usage</h3>
        <p className="muted">Original cloud MP4 quota only.</p>
      </header>
      <div className="admin-storage-visual">
        <div className="admin-storage-ring" aria-hidden="true">
          <svg viewBox="0 0 100 100">
            <circle cx="50" cy="50" r="42" />
            <circle className="is-used" cx="50" cy="50" r="42" />
          </svg>
          <div>
            <strong>{bytes == null ? "—" : formatBytes(used)}</strong>
            <span>used</span>
          </div>
        </div>
        <ul>
          <li>
            <i className="is-clips" />
            Clips
            <span>Not available</span>
          </li>
          <li>
            <i className="is-thumbs" />
            Thumbnails
            <span>Not available</span>
          </li>
          <li>
            <i className="is-other" />
            Other
            <span>Not available</span>
          </li>
        </ul>
      </div>
    </section>
  );
}
