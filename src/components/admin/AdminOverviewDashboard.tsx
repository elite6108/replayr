import { useEffect, useState } from "react";
import {
  fetchAdminAnalyticsGrowth,
  fetchAdminAnalyticsOverview,
  fetchAdminClips,
  fetchAdminOverview,
  fetchAdminUsers,
  fetchWorkerHealth,
  type AdminClipRow,
  type AdminOverview,
  type AdminUserRow,
} from "../../services/admin";
import { formatBytes, formatDuration, formatRelativeTime, initials } from "../../utils/format";
import { clipShareUrl } from "../../branding";

const METRICS: Array<{ key: keyof AdminOverview; label: string; format?: (value: number) => string }> = [
  { key: "users", label: "Accounts" },
  { key: "active7d", label: "Active in 7 days" },
  { key: "readyClips", label: "Ready clips" },
  { key: "clipsToday", label: "Clips today" },
  { key: "storageUsedBytes", label: "Cloud storage used", format: formatBytes },
  { key: "pendingCreatorApps", label: "Pending creators" },
  { key: "premiumCount", label: "Premium accounts" },
  { key: "pastDueCount", label: "Past due" },
  { key: "openErrors", label: "Open errors" },
  { key: "errors24h", label: "Error groups / 24h" },
];

export function AdminOverviewDashboard({ token }: { token: string }) {
  const [data, setData] = useState<AdminOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState("last_7");
  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [clips, setClips] = useState<AdminClipRow[]>([]);
  const [health, setHealth] = useState<Array<{ label: string; status: string }>>([]);
  const [chart, setChart] = useState<{ labels: string[]; active: Array<number | null>; signups: Array<number | null>; clips: Array<number | null> } | null>(null);
  const [chartError, setChartError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    void fetchAdminOverview(token)
      .then((next) => {
        setData(next);
        setError(null);
      })
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Could not load overview."));
  }, [token]);

  useEffect(() => {
    if (!token) return;
    void fetchAdminUsers(token)
      .then((body) => {
        setUsers([...body.users].sort((a, b) => Date.parse(b.createdAt || "") - Date.parse(a.createdAt || "")).slice(0, 5));
      })
      .catch(() => setUsers([]));
    void fetchAdminClips(token)
      .then((body) => setClips(body.clips.slice(0, 5)))
      .catch(() => setClips([]));
    void fetchWorkerHealth()
      .then((body) =>
        setHealth([
          { label: "API", status: body.ok ? "Operational" : "Unknown" },
          { label: "Storage (R2)", status: body.storage ? "Operational" : "Unknown" },
          { label: "Database", status: "Not monitored" },
          { label: "Web App", status: "Not monitored" },
          { label: "Desktop App", status: "Not monitored" },
        ]),
      )
      .catch(() =>
        setHealth([
          { label: "API", status: "Unknown" },
          { label: "Storage (R2)", status: "Unknown" },
          { label: "Database", status: "Not monitored" },
        ]),
      );
  }, [token]);

  useEffect(() => {
    if (!token) return;
    void Promise.all([fetchAdminAnalyticsGrowth(token, range), fetchAdminAnalyticsOverview(token, range)])
      .then(([growth, overview]) => {
        setChart({
          labels: growth.series.labels,
          active: growth.series.dau,
          signups: overview.series.new_users?.values ?? [],
          clips: overview.series.ready_cloud_clips_created?.values ?? [],
        });
        setChartError(null);
      })
      .catch((caught: unknown) => {
        setChart(null);
        setChartError(caught instanceof Error ? caught.message : "No activity data available yet.");
      });
  }, [token, range]);

  return (
    <section className="admin-dash">
      <header className="admin-dash-header">
        <div>
          <p className="admin-live">Live</p>
          <h2>What is on Replayr right now</h2>
          <p className="muted">Counts come from Auth and Postgres. Active users use last sign-in, not invented DAU.</p>
        </div>
        <label className="admin-range">
          <select value={range} onChange={(event) => setRange(event.target.value)} aria-label="Activity date range">
            <option value="last_7">Last 7 days</option>
            <option value="last_14">Last 14 days</option>
            <option value="last_30">Last 30 days</option>
          </select>
        </label>
      </header>
      {error ? <p className="error">{error}</p> : null}
      <div className="admin-metrics cols-2">
        {METRICS.map((card) => (
          <article key={card.key} className="admin-metric">
            <span>{card.label}</span>
            <strong>
              {data
                ? card.format
                  ? card.format(Number(data[card.key] ?? 0))
                  : Number(data[card.key] ?? 0).toLocaleString()
                : "—"}
            </strong>
          </article>
        ))}
      </div>
      {data ? (
        <p className="muted">
          Signed in today: {data.active1d.toLocaleString()} · last 30 days: {data.active30d.toLocaleString()}
        </p>
      ) : null}
      <div className="admin-mid">
        <section className="panel admin-panel">
          <h3>User Activity</h3>
          <p className="muted">Active users, new signups and clips created over time.</p>
          {chartError ? <p className="muted">{chartError}</p> : null}
          {chart && chart.labels.length ? <Sparkline chart={chart} /> : !chartError ? <p className="muted">No activity data available yet.</p> : null}
        </section>
        <section className="panel admin-panel">
          <h3>Storage Usage</h3>
          <p className="admin-storage-total">{data ? formatBytes(data.storageUsedBytes) : "—"} used</p>
          <p className="muted">Clips / Thumbnails / Other breakdown is not available.</p>
        </section>
      </div>
      <div className="admin-lower">
        <section className="panel admin-panel">
          <h3>Recent Signups</h3>
          {users.map((user) => {
            const name = user.displayName || user.username || user.email || "Player";
            return (
              <div className="admin-mini-row" key={user.id}>
                <span className="admin-avatar">{initials(name)}</span>
                <span>
                  <strong>{user.username ? `@${user.username}` : name}</strong>
                  <small>{user.email || "No email"}</small>
                </span>
                <em>{formatRelativeTime(user.createdAt)}</em>
              </div>
            );
          })}
          {!users.length ? <p className="muted">No recent accounts.</p> : null}
        </section>
        <section className="panel admin-panel">
          <h3>Recent Clips</h3>
          {clips.map((clip) => (
            <a className="admin-mini-row" key={clip.id} href={clipShareUrl(clip.slug)} target="_blank" rel="noreferrer">
              <span className="admin-clip-thumb" />
              <span>
                <strong>{clip.title || "Untitled clip"}</strong>
                <small>
                  {clip.ownerUsername ? `@${clip.ownerUsername}` : clip.ownerEmail || "Unknown"}
                  {clip.durationMs != null ? ` · ${formatDuration(clip.durationMs)}` : ""}
                </small>
              </span>
              <em>{formatRelativeTime(clip.createdAt)}</em>
            </a>
          ))}
          {!clips.length ? <p className="muted">No recent clips.</p> : null}
        </section>
        <section className="panel admin-panel">
          <h3>System Health</h3>
          {health.map((row) => (
            <div className="admin-health-row" key={row.label}>
              <span>{row.label}</span>
              <strong className={row.status === "Operational" ? "ok" : "muted"}>{row.status}</strong>
            </div>
          ))}
        </section>
      </div>
    </section>
  );
}

function Sparkline({
  chart,
}: {
  chart: { labels: string[]; active: Array<number | null>; signups: Array<number | null>; clips: Array<number | null> };
}) {
  const width = 420;
  const height = 140;
  const pad = { l: 8, r: 8, t: 8, b: 8 };
  const values = [...chart.active, ...chart.signups, ...chart.clips].filter((value): value is number => value != null);
  const max = Math.max(1, ...values);
  function path(series: Array<number | null>) {
    return series
      .map((value, index) => {
        if (value == null) return null;
        const x = pad.l + (chart.labels.length <= 1 ? 0 : (index / (chart.labels.length - 1)) * (width - pad.l - pad.r));
        const y = pad.t + (1 - value / max) * (height - pad.t - pad.b);
        return `${index === 0 ? "M" : "L"} ${x} ${y}`;
      })
      .filter(Boolean)
      .join(" ");
  }
  return (
    <svg className="admin-spark" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="User activity">
      <path d={path(chart.active)} fill="none" stroke="#7fd0ef" strokeWidth="2" />
      <path d={path(chart.signups)} fill="none" stroke="#5ee0b5" strokeWidth="2" />
      <path d={path(chart.clips)} fill="none" stroke="#c4b5fd" strokeWidth="2" />
    </svg>
  );
}
