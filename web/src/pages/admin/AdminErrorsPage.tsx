import { useEffect, useState } from "react";
import { fetchAdminErrors, resolveAdminError, type AdminErrorRow } from "../../lib/admin";
import { useAuth } from "../../lib/auth";
import { formatClipDate } from "../../lib/format";

export function AdminErrorsPage() {
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const [query, setQuery] = useState("");
  const [surface, setSurface] = useState("");
  const [resolved, setResolved] = useState<"open" | "all">("open");
  const [errors, setErrors] = useState<AdminErrorRow[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load() {
    if (!token) return;
    setError(null);
    try {
      const list = await fetchAdminErrors(token, {
        q: query || undefined,
        surface: surface || undefined,
        resolved,
      });
      setErrors(list.items);
      setTotal(list.total);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load error logs.");
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  async function resolve(row: AdminErrorRow) {
    if (!token) return;
    setBusyId(row.fingerprint);
    try {
      await resolveAdminError(token, row.fingerprint, true);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not resolve that error.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="admin-section">
      <header className="admin-header">
        <div>
          <p className="eyebrow">Telemetry</p>
          <h2>Error logs</h2>
          <p className="muted">
            {total ? `${total} groups` : "Grouped client and Worker errors. Tokens are stripped before store."}
          </p>
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
            placeholder="Search message"
            aria-label="Search errors"
          />
          <select value={surface} onChange={(event) => setSurface(event.target.value)} aria-label="Surface">
            <option value="">All surfaces</option>
            <option value="desktop">Desktop</option>
            <option value="web">Web</option>
            <option value="mobile">Mobile</option>
            <option value="worker">Worker</option>
          </select>
          <select
            value={resolved}
            onChange={(event) => setResolved(event.target.value as "open" | "all")}
            aria-label="Status"
          >
            <option value="open">Open</option>
            <option value="all">Including resolved</option>
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
              <th>Error</th>
              <th>Surface</th>
              <th>Count</th>
              <th>Last seen</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {errors.map((row) => (
              <tr key={row.fingerprint}>
                <td>
                  <strong>{row.message}</strong>
                  <span className="muted">
                    {row.release || "unknown build"}
                    {row.path ? ` · ${row.path}` : ""}
                    {row.resolvedAt ? " · resolved" : ""}
                  </span>
                  {openId === row.fingerprint && row.stack ? <pre className="admin-stack">{row.stack}</pre> : null}
                </td>
                <td>
                  <span className={`admin-pill status-${row.level === "crash" ? "failed" : "ready"}`}>
                    {row.surface} · {row.level}
                  </span>
                </td>
                <td>{row.count.toLocaleString()}</td>
                <td>{formatClipDate(row.lastSeenAt)}</td>
                <td className="admin-actions">
                  {row.stack ? (
                    <button
                      className="btn ghost"
                      type="button"
                      onClick={() => setOpenId((current) => (current === row.fingerprint ? null : row.fingerprint))}
                    >
                      {openId === row.fingerprint ? "Hide stack" : "Stack"}
                    </button>
                  ) : null}
                  {!row.resolvedAt ? (
                    <button
                      className="btn ghost"
                      type="button"
                      disabled={busyId === row.fingerprint}
                      onClick={() => void resolve(row)}
                    >
                      Resolve
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {errors.length === 0 ? <p className="muted admin-empty">No matching error groups.</p> : null}
      </div>
    </section>
  );
}
