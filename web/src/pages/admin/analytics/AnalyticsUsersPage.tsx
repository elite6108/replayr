import { useEffect, useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import {
  downloadAnalyticsUserJourney,
  fetchAnalyticsUserJourney,
  revealAnalyticsUser,
  searchAnalyticsUsers,
  type AnalyticsUserIdentity,
  type AnalyticsUserJourney,
} from "../../../lib/adminAnalytics";
import { AnalyticsMfaGate } from "../../../components/auth/AnalyticsMfaGate";
import { useAuth } from "../../../lib/auth";
import { formatBytes } from "../../../lib/format";
import { useStaffPermissions } from "../../../lib/staff";

export function AnalyticsUsersPage() {
  const { can } = useStaffPermissions();
  if (!can("analytics.users.view")) return <Navigate to="/admin/people/users" replace />;
  return (
    <AnalyticsMfaGate>
      <AnalyticsUsersContent />
    </AnalyticsMfaGate>
  );
}

function AnalyticsUsersContent() {
  const { userId = "" } = useParams();
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const [selected, setSelected] = useState<AnalyticsUserIdentity | null>(null);
  const [reason, setReason] = useState("");
  const [revealToken, setRevealToken] = useState<string | null>(null);
  const [revealExpiresAt, setRevealExpiresAt] = useState<string | null>(null);
  const [journey, setJourney] = useState<AnalyticsUserJourney | null>(null);
  const [fromDate, setFromDate] = useState(() => defaultDateRange().from);
  const [toDate, setToDate] = useState(() => defaultDateRange().to);
  const [busy, setBusy] = useState(false);
  const [exportBusy, setExportBusy] = useState<"csv" | "pdf" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token || !userId) return;
    let cancelled = false;
    setBusy(true);
    setError(null);
    void searchAnalyticsUsers(token, userId)
      .then((result) => {
        if (cancelled) return;
        const exact = result.users.find((user) => user.userId === userId);
        if (!exact) throw new Error("That account was not found.");
        setSelected(exact);
      })
      .catch((caught) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Could not load that account.");
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token, userId]);

  async function onReveal() {
    if (!token || !userId || reason.trim().length < 8) return;
    if (!window.confirm("Reveal this user’s count-only journey for 10 minutes? This access is audited.")) return;
    setBusy(true);
    setError(null);
    setRevealToken(null);
    setJourney(null);
    try {
      const reveal = await revealAnalyticsUser(token, userId, reason.trim());
      const range = dateRangeIso(fromDate, toDate);
      const next = await fetchAnalyticsUserJourney(token, reveal.revealToken, {
        userId,
        limit: 50,
        ...range,
      });
      setSelected(reveal.user);
      setRevealToken(reveal.revealToken);
      setRevealExpiresAt(reveal.expiresAt);
      setJourney(next);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not reveal that journey.");
    } finally {
      setBusy(false);
    }
  }

  async function applyDateRange() {
    if (!token || !userId || !revealToken) return;
    setBusy(true);
    setError(null);
    try {
      const range = dateRangeIso(fromDate, toDate);
      const next = await fetchAnalyticsUserJourney(token, revealToken, {
        userId,
        limit: 50,
        ...range,
      });
      setJourney(next);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load that date range.");
    } finally {
      setBusy(false);
    }
  }

  async function loadMore() {
    if (!token || !userId || !revealToken || journey?.nextOffset == null) return;
    setBusy(true);
    setError(null);
    try {
      const next = await fetchAnalyticsUserJourney(token, revealToken, {
        userId,
        offset: journey.nextOffset,
        limit: 50,
        from: journey.range.from,
        to: journey.range.to,
      });
      setJourney({
        ...next,
        events: [...journey.events, ...next.events],
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load more journey events.");
    } finally {
      setBusy(false);
    }
  }

  async function downloadExport(format: "csv" | "pdf") {
    if (!token || !userId || !revealToken || !journey) return;
    setExportBusy(format);
    setError(null);
    try {
      const blob = await downloadAnalyticsUserJourney(token, revealToken, format, {
        userId,
        from: journey.range.from,
        to: journey.range.to,
      });
      saveBlob(blob, `replayr-user-analytics-${new Date().toISOString().slice(0, 10)}.${format}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not download that export.");
    } finally {
      setExportBusy(null);
    }
  }

  return (
    <section className="admin-section analytics-page">
      <header className="admin-header">
        <div>
          <p className="eyebrow">People · Users</p>
          <h2>{selected?.displayName || selected?.username || selected?.email || "User analytics"}</h2>
          <p className="muted">
            MFA-protected, reason-required, audited access. Raw events expire after 30 days and never include user content.
          </p>
        </div>
      </header>
      <p><Link to="/admin/people/users">← Back to users</Link></p>
      {error ? <p className="error">{error}</p> : null}

      {selected && !journey ? (
        <div className="admin-panel analytics-mfa-card">
          <h3>Request temporary access</h3>
          <p className="muted">
            {selected.displayName || selected.username || selected.email || "Selected account"} · the reason is retained in the audit log.
          </p>
          <div className="analytics-toolbar">
            <label>
              Access reason
              <input
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Example: investigate activation funnel issue"
                maxLength={160}
              />
            </label>
            <button className="btn primary" type="button" disabled={busy || reason.trim().length < 8} onClick={() => void onReveal()}>
              {busy ? "Opening…" : "Reveal for 10 minutes"}
            </button>
          </div>
        </div>
      ) : null}

      {journey && selected ? (
        <>
          <div className="admin-header">
            <div>
              <h3>{selected.displayName || selected.username || selected.email || "User journey"}</h3>
              <p className="muted">
                {selected.username ? `@${selected.username} · ` : ""}
                reveal expires {formatDate(revealExpiresAt)}
              </p>
            </div>
            <div className="analytics-toolbar">
              <button className="btn" type="button" disabled={exportBusy != null} onClick={() => void downloadExport("csv")}>
                {exportBusy === "csv" ? "Exporting…" : "Export CSV"}
              </button>
              <button className="btn" type="button" disabled={exportBusy != null} onClick={() => void downloadExport("pdf")}>
                {exportBusy === "pdf" ? "Building…" : "Download PDF"}
              </button>
            </div>
          </div>
          <div className="admin-panel">
            <div className="analytics-toolbar">
              <label>
                From date
                <input
                  type="date"
                  value={fromDate}
                  max={toDate}
                  onChange={(event) => setFromDate(event.target.value)}
                />
              </label>
              <label>
                Through date
                <input
                  type="date"
                  value={toDate}
                  min={fromDate}
                  max={todayUtcDate()}
                  onChange={(event) => setToDate(event.target.value)}
                />
              </label>
              <button className="btn primary" type="button" disabled={busy} onClick={() => void applyDateRange()}>
                {busy ? "Loading…" : "Apply dates"}
              </button>
            </div>
            <p className="muted">
              Showing activity from {formatDate(journey.range.from)} through {formatDate(journey.range.to)}. Date ranges are limited to 30 days.
            </p>
          </div>
          <div className="analytics-kpis">
            <CountCard label="Cloud clips created" value={journey.counts.cloudClips} />
            <CountCard label="Screenshots created" value={journey.counts.screenshots} />
            <CountCard label="Messages sent" value={journey.counts.messagesSent} />
            <CountCard label="Conversations joined" value={journey.counts.conversations} />
            <CountCard label="Folders created" value={journey.counts.foldersOwned} />
            <CountCard label="Folder shares joined" value={journey.counts.foldersShared} />
            <CountCard label="Accounts followed" value={journey.counts.following} />
            <CountCard label="New followers" value={journey.counts.followers} />
          </div>
          <div className="admin-section">
            <h3>Current account snapshot</h3>
            <p className="muted">These values are current and are not reconstructed historically.</p>
            <div className="analytics-kpis">
              <CountCard label="Cloud storage" value={formatBytes(journey.counts.storageUsedBytes)} />
              <CountCard label="Storage limit" value={formatBytes(journey.counts.storageLimitBytes)} />
              <CountCard label="Plan" value={journey.counts.plan} />
            </div>
          </div>
          <div className="admin-section">
            <h3>Observed offline activity</h3>
            <p className="muted">{journey.observedActivity.label}. These are activity totals, not device inventory.</p>
            <div className="analytics-kpis">
              <CountCard label="Clips saved" value={journey.observedActivity.localClipsSaved} />
              <CountCard label="Clips deleted" value={journey.observedActivity.localClipsDeleted} />
              <CountCard label="Screenshots created" value={journey.observedActivity.localScreenshotsCreated} />
              <CountCard label="Screenshots deleted" value={journey.observedActivity.localScreenshotsDeleted} />
            </div>
          </div>
          <div className="analytics-table-wrap">
            <table className="analytics-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Event</th>
                  <th>Platform</th>
                  <th>Count-only properties</th>
                </tr>
              </thead>
              <tbody>
                {journey.events.map((event, index) => (
                  <tr key={`${event.occurredAt}:${event.eventName}:${index}`}>
                    <td>{formatDate(event.occurredAt)}</td>
                    <td>{event.eventName}</td>
                    <td>{event.platform || "—"}</td>
                    <td className="muted">{safePropertyText(event.properties)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {journey.nextOffset != null ? (
            <button className="btn" type="button" disabled={busy} onClick={() => void loadMore()}>
              {busy ? "Loading…" : "Load more"}
            </button>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function CountCard({ label, value }: { label: string; value: number | string }) {
  return (
    <article className="analytics-kpi">
      <div className="analytics-kpi-label">{label}</div>
      <strong>{value}</strong>
    </article>
  );
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

function safePropertyText(properties: Record<string, string | number | boolean | null>): string {
  const entries = Object.entries(properties);
  return entries.length === 0 ? "—" : entries.map(([key, value]) => `${key}: ${String(value)}`).join(" · ");
}

function saveBlob(blob: Blob, filename: string) {
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(href);
}

function defaultDateRange(): { from: string; to: string } {
  const today = new Date();
  const to = today.toISOString().slice(0, 10);
  today.setUTCDate(today.getUTCDate() - 29);
  return { from: today.toISOString().slice(0, 10), to };
}

function todayUtcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function dateRangeIso(from: string, to: string): { from: string; to: string } {
  const start = new Date(`${from}T00:00:00.000Z`);
  let end = new Date(`${to}T23:59:59.999Z`);
  if (!from || !to || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
    throw new Error("Choose a valid start and end date.");
  }
  const now = new Date();
  if (end > now && to === todayUtcDate()) end = now;
  if (end.getTime() - start.getTime() >= 30 * 24 * 60 * 60 * 1000) {
    throw new Error("Date ranges are limited to 30 days.");
  }
  if (end > now) throw new Error("The end date cannot be in the future.");
  return { from: start.toISOString(), to: end.toISOString() };
}
