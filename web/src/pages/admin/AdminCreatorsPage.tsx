import { useEffect, useState } from "react";
import { fetchAdminCreators, reviewCreatorApplication, type AdminCreatorRow } from "../../lib/admin";
import { useAuth } from "../../lib/auth";
import { formatClipDate } from "../../lib/format";

export function AdminCreatorsPage() {
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const [status, setStatus] = useState("pending");
  const [applications, setApplications] = useState<AdminCreatorRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load(nextStatus = status) {
    if (!token) return;
    setError(null);
    try {
      const next = await fetchAdminCreators(token, nextStatus);
      setApplications(next.applications);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load applications.");
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  async function review(row: AdminCreatorRow, next: "approved" | "rejected") {
    if (!token) return;
    const note = next === "rejected" ? window.prompt("Optional note for this rejection", "") : "";
    if (next === "rejected" && note == null) return;
    if (!window.confirm(`${next === "approved" ? "Approve" : "Reject"} ${row.displayName}?`)) return;
    setBusyId(row.id);
    try {
      await reviewCreatorApplication(token, row.id, next, note || undefined);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not review that application.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="admin-section">
      <header className="admin-header">
        <div>
          <p className="eyebrow">Program</p>
          <h2>Creator applications</h2>
          <p className="muted">Approving marks the profile verified. Applicants can still only see their own row.</p>
        </div>
        <div className="admin-filters">
          <select
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              void load(event.target.value);
            }}
            aria-label="Application status"
          >
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
            <option value="all">All</option>
          </select>
        </div>
      </header>
      {error ? <p className="error">{error}</p> : null}
      <div className="admin-cards">
        {applications.map((row) => (
          <article key={row.id} className="admin-card">
            <header>
              <strong>{row.displayName}</strong>
              <span className={`admin-pill status-${row.status}`}>{row.status}</span>
            </header>
            <p className="muted">
              {row.email || "No email"} {row.username ? `· @${row.username}` : ""} · {formatClipDate(row.createdAt)}
            </p>
            <p>
              <a href={row.channelUrl} target="_blank" rel="noreferrer">
                {row.channelUrl}
              </a>
            </p>
            {row.game ? <p>Game: {row.game}</p> : null}
            {row.note ? <p>{row.note}</p> : null}
            {row.reviewNote ? <p className="muted">Review: {row.reviewNote}</p> : null}
            {row.status === "pending" ? (
              <div className="row">
                <button className="btn primary" type="button" disabled={busyId === row.id} onClick={() => void review(row, "approved")}>
                  Approve
                </button>
                <button className="btn danger" type="button" disabled={busyId === row.id} onClick={() => void review(row, "rejected")}>
                  Reject
                </button>
              </div>
            ) : null}
          </article>
        ))}
      </div>
      {applications.length === 0 ? <p className="muted">No applications in this view.</p> : null}
    </section>
  );
}
