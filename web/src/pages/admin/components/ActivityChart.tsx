import { AnalyticsLineChart } from "../../../components/analytics/AnalyticsLineChart";
import type { AnalyticsSeries } from "../../../lib/adminAnalytics";

export function ActivityChart({
  loading,
  error,
  active,
  signups,
  clips,
}: {
  loading: boolean;
  error: string | null;
  active: AnalyticsSeries | null;
  signups: AnalyticsSeries | null;
  clips: AnalyticsSeries | null;
}) {
  const series = [
    active ? { key: "active", label: "Active users", color: "#7fd0ef", data: active } : null,
    signups ? { key: "signups", label: "New signups", color: "#5ee0b5", data: signups } : null,
    clips ? { key: "clips", label: "Clips created", color: "#c4b5fd", data: clips } : null,
  ].filter((item): item is { key: string; label: string; color: string; data: AnalyticsSeries } => Boolean(item));
  const empty = !loading && !error && series.every((item) => item.data.labels.length === 0);

  return (
    <section className="admin-panel admin-activity">
      {loading ? <p className="muted">Loading activity…</p> : null}
      {error ? <p className="error">{error}</p> : null}
      {empty ? (
        <>
          <header>
            <h3>User Activity</h3>
            <p className="muted">Active users, new signups and clips created over time.</p>
          </header>
          <p className="muted">No activity data available yet.</p>
        </>
      ) : series.length ? (
        <AnalyticsLineChart title="User Activity" subtitle="Active users, new signups and clips created over time." series={series} />
      ) : !loading && !error ? (
        <>
          <header>
            <h3>User Activity</h3>
            <p className="muted">Active users, new signups and clips created over time.</p>
          </header>
          <p className="muted">No activity data available yet.</p>
        </>
      ) : null}
    </section>
  );
}
