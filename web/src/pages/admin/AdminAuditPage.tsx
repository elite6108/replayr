import { Link } from "react-router-dom";
import { useEffect, useState } from "react";
import { AnalyticsDateRangePicker } from "../../components/analytics/AnalyticsDateRangePicker";
import { AnalyticsEmptyState } from "../../components/analytics/AnalyticsEmptyState";
import { fetchAdminAudit, type AuditLogResponse } from "../../lib/adminAnalytics";
import { useAuth } from "../../lib/auth";
import { useAnalyticsQuery } from "./analytics/useAnalyticsQuery";

export function AdminAuditPage() {
  const { session } = useAuth();
  const query = useAnalyticsQuery();
  const [actorType, setActorType] = useState("");
  const [action, setAction] = useState("");
  const [search, setSearch] = useState("");
  const [data, setData] = useState<AuditLogResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    const token = session?.access_token;
    if (!token) return;
    let cancelled = false;
    const extra = new URLSearchParams(query.search);
    if (actorType) extra.set("actorType", actorType);
    if (action) extra.set("action", action);
    if (search) extra.set("search", search);
    void fetchAdminAudit(token, `?${extra.toString()}`)
      .then((next) => {
        if (!cancelled) {
          setData(next);
          setError(null);
        }
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Could not load the audit log.");
      });
    return () => {
      cancelled = true;
    };
  }, [session?.access_token, query.search, actorType, action, search]);

  return (
    <section className="admin-section analytics-page">
      <header className="admin-header">
        <div>
          <p className="eyebrow">Operations</p>
          <h2>Audit Log</h2>
          <p className="muted">Append-only security and admin history. Separate from analytics and folder activity.</p>
        </div>
        <div className="analytics-toolbar">
          <AnalyticsDateRangePicker />
        </div>
      </header>
      <div className="analytics-toolbar">
        <select value={actorType} onChange={(event) => setActorType(event.target.value)} aria-label="Actor type">
          <option value="">All actors</option>
          <option value="admin">Admin</option>
          <option value="user">User</option>
          <option value="system">System</option>
        </select>
        <input value={action} onChange={(event) => setAction(event.target.value)} placeholder="Action" aria-label="Action" />
        <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search action" aria-label="Search" />
      </div>
      {error ? (
        <AnalyticsEmptyState title="Could not load audit log" body={error} />
      ) : (
        <div className="analytics-table-wrap">
          <table className="analytics-table">
            <thead>
              <tr>
                <th>Timestamp</th>
                <th>Actor</th>
                <th>Action</th>
                <th>Target</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {(data?.items ?? []).map((row) => (
                <tr key={row.id}>
                  <td>{new Date(row.createdAt).toLocaleString()}</td>
                  <td>
                    {row.actorType}
                    {row.actorUserId ? ` · ${row.actorUserId.slice(0, 8)}` : ""}
                  </td>
                  <td>{row.actionLabel}</td>
                  <td>
                    {row.targetHref && row.targetId ? (
                      <Link to={row.targetHref}>{row.targetType} {row.targetId.slice(0, 8)}</Link>
                    ) : (
                      `${row.targetType ?? "—"} ${row.targetId ? row.targetId.slice(0, 8) : ""}`
                    )}
                  </td>
                  <td>
                    <button type="button" onClick={() => setOpenId(openId === row.id ? null : row.id)}>
                      {openId === row.id ? "Hide" : "Show"}
                    </button>
                    {openId === row.id ? <pre>{JSON.stringify(row.metadata, null, 2)}</pre> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {data?.nextCursor ? <p className="muted">More rows exist. Narrow the date range or filters.</p> : null}
        </div>
      )}
    </section>
  );
}
