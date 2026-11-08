import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  fetchModerationReports,
  resolveModerationReport,
  unsuspendModerationUser,
  type ModerationReport,
  type ModerationResolveAction,
} from "../../../lib/admin";
import { useAuth } from "../../../lib/auth";
import { formatClipDate } from "../../../lib/format";

const ACTIONS: Array<{ id: ModerationResolveAction; label: string; confirm: string }> = [
  { id: "dismiss", label: "Dismiss", confirm: "Dismiss this report? The content stays up." },
  { id: "remove_content", label: "Remove content", confirm: "Remove this content from Replayr?" },
  { id: "suspend_user", label: "Suspend account", confirm: "Suspend this account until a moderator unsuspends it?" },
  {
    id: "remove_and_suspend",
    label: "Remove and suspend",
    confirm: "Remove this content and suspend the account?",
  },
];

export function ReportQueue({ canAct }: { canAct: boolean }) {
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const [status, setStatus] = useState<"open" | "actioned" | "dismissed" | "all">("open");
  const [page, setPage] = useState(1);
  const [reports, setReports] = useState<ModerationReport[]>([]);
  const [total, setTotal] = useState(0);
  const [openTotal, setOpenTotal] = useState(0);
  const [slaHours, setSlaHours] = useState(24);
  const [limit, setLimit] = useState(30);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [note, setNote] = useState("");

  async function load(nextPage = page, nextStatus = status) {
    if (!token) return;
    setError(null);
    try {
      const body = await fetchModerationReports(token, { status: nextStatus, page: nextPage });
      setReports(body.reports);
      setTotal(body.total);
      setOpenTotal(body.openTotal);
      setSlaHours(body.slaHours);
      setLimit(body.limit);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load reports.");
    }
  }

  useEffect(() => {
    void load(1, status);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, status]);

  async function resolve(report: ModerationReport, action: ModerationResolveAction) {
    if (!token || !canAct) return;
    const chosen = ACTIONS.find((item) => item.id === action);
    if (!chosen || !window.confirm(chosen.confirm)) return;
    setBusyId(report.id);
    setError(null);
    try {
      await resolveModerationReport(token, report.id, { action, note: note.trim() || undefined });
      setNote("");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not resolve that report.");
    } finally {
      setBusyId(null);
    }
  }

  async function unsuspend(userId: string) {
    if (!token || !canAct) return;
    if (!window.confirm("Unsuspend this account?")) return;
    setBusyId(userId);
    setError(null);
    try {
      await unsuspendModerationUser(token, userId);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not unsuspend that account.");
    } finally {
      setBusyId(null);
    }
  }

  const pageCount = Math.max(1, Math.ceil(total / Math.max(1, limit)));

  return (
    <>
      <form
        className="admin-filters"
        onSubmit={(event) => {
          event.preventDefault();
          setPage(1);
          void load(1, status);
        }}
      >
        <select
          value={status}
          aria-label="Report status"
          onChange={(event) => {
            const next = event.target.value as typeof status;
            setStatus(next);
            setPage(1);
          }}
        >
          <option value="open">Open · oldest first</option>
          <option value="actioned">Actioned</option>
          <option value="dismissed">Dismissed</option>
          <option value="all">All</option>
        </select>
        <button className="admin-btn" type="submit">
          Refresh
        </button>
        <span className="muted">
          {openTotal} open · review within {slaHours} hours
        </span>
      </form>
      {error ? <p className="error">{error}</p> : null}
      <div className="admin-panel admin-table-card">
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Report</th>
                <th>Content</th>
                <th>Account</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {reports.map((report) => (
                <tr key={report.id}>
                  <td>
                    <strong>{labelReason(report.reason)}</strong>
                    <span className="muted">
                      {report.targetType} · {formatClipDate(report.createdAt)} · {report.ageHours}h
                      {report.reporter.username ? ` · @${report.reporter.username}` : ""}
                    </span>
                    {report.overdue ? <span className="admin-pill status-failed">Overdue</span> : null}
                    {report.details ? <span className="muted">{report.details}</span> : null}
                    {report.resolution ? <span className="muted">Note: {report.resolution}</span> : null}
                  </td>
                  <td>
                    {report.targetPath ? <Link to={report.targetPath}>{report.preview}</Link> : <span>{report.preview}</span>}
                  </td>
                  <td>
                    {report.targetUser ? (
                      <>
                        <strong>{report.targetUser.displayName}</strong>
                        <span className="muted">
                          {report.targetUser.username ? `@${report.targetUser.username}` : "No username"}
                          {report.targetUser.suspended ? " · suspended" : ""}
                        </span>
                      </>
                    ) : (
                      <span className="muted">No account</span>
                    )}
                  </td>
                  <td className="admin-actions">
                    {report.status === "open" && canAct ? (
                      ACTIONS.map((action) => (
                        <button
                          key={action.id}
                          className={`admin-btn${action.id === "dismiss" ? "" : " danger"}`}
                          type="button"
                          disabled={busyId === report.id || ((action.id === "suspend_user" || action.id === "remove_and_suspend") && !report.targetUser)}
                          onClick={() => void resolve(report, action.id)}
                        >
                          {action.label}
                        </button>
                      ))
                    ) : (
                      <span className="admin-pill">{report.status}</span>
                    )}
                    {canAct && report.targetUser?.suspended ? (
                      <button
                        className="admin-btn"
                        type="button"
                        disabled={busyId === report.targetUser.id}
                        onClick={() => void unsuspend(report.targetUser!.id)}
                      >
                        Unsuspend
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {reports.length === 0 ? <p className="muted admin-empty">No reports in this view.</p> : null}
        </div>
      </div>
      {canAct && status === "open" ? (
        <label className="field">
          Resolution note
          <input
            value={note}
            maxLength={500}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Optional. Stored on the report and used as the suspension reason."
          />
        </label>
      ) : null}
      {pageCount > 1 ? (
        <div className="row">
          <button
            className="admin-btn"
            type="button"
            disabled={page <= 1}
            onClick={() => {
              const next = page - 1;
              setPage(next);
              void load(next, status);
            }}
          >
            Previous
          </button>
          <span className="muted">
            Page {page} of {pageCount}
          </span>
          <button
            className="admin-btn"
            type="button"
            disabled={page >= pageCount}
            onClick={() => {
              const next = page + 1;
              setPage(next);
              void load(next, status);
            }}
          >
            Next
          </button>
        </div>
      ) : null}
    </>
  );
}

function labelReason(reason: string): string {
  return reason.replace(/_/g, " ");
}
