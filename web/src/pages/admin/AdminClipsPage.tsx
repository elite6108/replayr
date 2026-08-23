import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { clipShareUrl } from "../../lib/supabase";
import { deleteAdminClip, fetchAdminClips, type AdminClipRow } from "../../lib/admin";
import { useAuth } from "../../lib/auth";
import { formatBytes, formatClipDate, formatDurationMs } from "../../lib/format";

export function AdminClipsPage() {
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [visibility, setVisibility] = useState("");
  const [clips, setClips] = useState<AdminClipRow[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  async function load() {
    if (!token) return;
    setError(null);
    try {
      const list = await fetchAdminClips(token, {
        q: query || undefined,
        status: status || undefined,
        visibility: visibility || undefined,
      });
      setClips(list.items);
      setTotal(list.total);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load clips.");
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  async function copyShare(clip: AdminClipRow) {
    await navigator.clipboard.writeText(clipShareUrl(clip.slug));
    setCopied(clip.id);
    window.setTimeout(() => setCopied((current) => (current === clip.id ? null : current)), 1600);
  }

  async function remove(clip: AdminClipRow) {
    if (!token) return;
    if (
      !window.confirm(
        `Soft-delete ${clip.title || clip.slug}? The share link stops working and R2 objects are removed. This is not a mass wipe.`,
      )
    ) {
      return;
    }
    setBusyId(clip.id);
    try {
      await deleteAdminClip(token, clip.id);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not delete that clip.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="admin-section">
      <header className="admin-header">
        <div>
          <p className="eyebrow">Library</p>
          <h2>Clips</h2>
          <p className="muted">{total ? `${total} matching` : "Includes unlisted clips for support. Links stay /c/{slug}."}</p>
        </div>
        <form
          className="admin-filters"
          onSubmit={(event) => {
            event.preventDefault();
            void load();
          }}
        >
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Title, slug, email, username"
            aria-label="Search clips"
          />
          <select value={status} onChange={(event) => setStatus(event.target.value)} aria-label="Status">
            <option value="">All live statuses</option>
            <option value="ready">Ready</option>
            <option value="uploading">Uploading</option>
            <option value="processing">Processing</option>
            <option value="failed">Failed</option>
            <option value="deleted">Deleted</option>
          </select>
          <select value={visibility} onChange={(event) => setVisibility(event.target.value)} aria-label="Visibility">
            <option value="">Any visibility</option>
            <option value="unlisted">Unlisted</option>
            <option value="public">Public</option>
            <option value="private">Private</option>
          </select>
          <button className="btn primary" type="submit">
            Filter
          </button>
        </form>
      </header>
      {error ? <p className="error">{error}</p> : null}
      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Clip</th>
              <th>Owner</th>
              <th>Status</th>
              <th>Size</th>
              <th>Created</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {clips.map((clip) => (
              <tr key={clip.id}>
                <td>
                  <strong>{clip.title || clip.slug}</strong>
                  <span className="muted">
                    {clip.gameName || "No game"} · {formatDurationMs(clip.durationMs)} · {clip.visibility}
                  </span>
                </td>
                <td>
                  {clip.ownerUsername ? `@${clip.ownerUsername}` : clip.ownerEmail || "—"}
                  {clip.ownerUsername && clip.ownerEmail ? (
                    <span className="muted">{clip.ownerEmail}</span>
                  ) : null}
                </td>
                <td>
                  <span className={`admin-pill status-${clip.status}`}>{clip.status}</span>
                </td>
                <td>{formatBytes(clip.fileSizeBytes)}</td>
                <td>{formatClipDate(clip.createdAt)}</td>
                <td className="admin-actions">
                  <Link className="btn ghost" to={clip.sharePath}>
                    Open
                  </Link>
                  <button className="btn ghost" type="button" onClick={() => void copyShare(clip)}>
                    {copied === clip.id ? "Copied" : "Copy link"}
                  </button>
                  {clip.status !== "deleted" ? (
                    <button
                      className="btn danger"
                      type="button"
                      disabled={busyId === clip.id}
                      onClick={() => void remove(clip)}
                    >
                      Soft-delete
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {clips.length === 0 ? <p className="muted admin-empty">No clips match.</p> : null}
      </div>
    </section>
  );
}
