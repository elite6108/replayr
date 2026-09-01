import { Link, useNavigate, useParams } from "react-router-dom";
import { useEffect, useState } from "react";
import { AnalyticsEmptyState } from "../../../components/analytics/AnalyticsEmptyState";
import { AnalyticsKpiCard } from "../../../components/analytics/AnalyticsKpiCard";
import { AnalyticsLineChart } from "../../../components/analytics/AnalyticsLineChart";
import {
  downloadAnalyticsReportCsv,
  downloadAnalyticsReportPdf,
  fetchAnalyticsReport,
  regenerateAnalyticsReport,
  type AnalyticsReportDetail,
} from "../../../lib/adminAnalytics";
import { useAuth } from "../../../lib/auth";

const CSV_TOPICS = ["downloads", "users", "growth", "retention", "acquisition", "clips", "games", "features", "filters", "folders", "sharing", "revenue", "infrastructure", "health"];

function MetricTable({ title, metrics }: { title: string; metrics?: Array<{ key: string; label: string; value: number | null; previous: number | null; availability: string }> }) {
  return (
    <>
      <h3>{title}</h3>
      {!metrics?.length ? (
        <p className="muted">No tracked data for this section in the selected period.</p>
      ) : (
        <div className="analytics-table-wrap">
          <table className="analytics-table">
            <thead><tr><th>Metric</th><th>Value</th><th>Previous</th><th>Availability</th></tr></thead>
            <tbody>
              {metrics.map((row) => (
                <tr key={row.key}>
                  <td>{row.label}</td>
                  <td>{row.value == null ? "—" : row.value}</td>
                  <td>{row.previous == null ? "—" : row.previous}</td>
                  <td>{row.availability}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function saveBlob(blob: Blob, name: string) {
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = name;
  link.click();
  URL.revokeObjectURL(href);
}

export function AnalyticsReportDetailPage() {
  const { id } = useParams();
  const { session } = useAuth();
  const navigate = useNavigate();
  const [data, setData] = useState<AnalyticsReportDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [topic, setTopic] = useState("downloads");

  useEffect(() => {
    const token = session?.access_token;
    if (!token || !id) return;
    void fetchAnalyticsReport(token, id)
      .then(setData)
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Could not load report."));
  }, [session?.access_token, id]);

  if (error) return <AnalyticsEmptyState title="Could not load report" body={error} />;
  if (!data) return <section className="admin-section"><p className="muted">Loading report…</p></section>;

  return (
    <section className="admin-section analytics-page">
      <header className="admin-header">
        <div>
          <p className="eyebrow">Replayr Analytics Report</p>
          <h2>{data.title}</h2>
          <p className="muted">
            {data.snapshot.meta.label} · Generated {data.generatedAt.slice(0, 19).replace("T", " ")} · {data.generatedByLabel} · Version {data.reportVersion}
          </p>
        </div>
        <div className="analytics-toolbar">
          <button type="button" className="button" onClick={() => void downloadAnalyticsReportPdf(session!.access_token, data.id).then((blob) => saveBlob(blob, `${data.id}.pdf`))}>Download PDF</button>
          <select value={topic} onChange={(event) => setTopic(event.target.value)} aria-label="CSV topic">
            {CSV_TOPICS.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
          <button type="button" className="button" onClick={() => void downloadAnalyticsReportCsv(session!.access_token, data.id, topic).then((blob) => saveBlob(blob, `${data.id}-${topic}.csv`))}>Export CSV</button>
          <button type="button" className="button" onClick={() => void regenerateAnalyticsReport(session!.access_token, data.id).then((next) => navigate(`/admin/analytics/reports/${next.id}`))}>Regenerate</button>
        </div>
      </header>
      <p><Link to="/admin/analytics/reports">← All reports</Link></p>
      <div className="analytics-insights">
        <h3>Executive summary</h3>
        <p>{data.summary.executive}</p>
      </div>
      <div className="analytics-insights">
        <h3>Needs attention</h3>
        <ul>{(data.summary.attention ?? []).map((item) => <li key={item}>{item}</li>)}</ul>
      </div>
      <div className="admin-stats analytics-kpis">
        {data.snapshot.kpis.map((kpi) => <AnalyticsKpiCard key={kpi.key} kpi={kpi} />)}
      </div>
      <h3>Downloads</h3>
      {data.snapshot.downloads.tracking.notice ? <p className="muted">{data.snapshot.downloads.tracking.notice}</p> : null}
      <p>App clicks {data.snapshot.downloads.app.app_download_clicks ?? "—"} · Installers {data.snapshot.downloads.app.installer_downloads ?? "—"} · Media total {data.snapshot.downloads.mediaTotal ?? "—"}</p>
      <p className="muted">
        Highest tracked day {data.snapshot.downloads.stats.highest ? `${data.snapshot.downloads.stats.highest.day} (${data.snapshot.downloads.stats.highest.value})` : "—"}
        {" · "}Lowest {data.snapshot.downloads.stats.lowest ? `${data.snapshot.downloads.stats.lowest.day} (${data.snapshot.downloads.stats.lowest.value})` : "—"}
        {" · "}Average {data.snapshot.downloads.stats.average == null ? "—" : data.snapshot.downloads.stats.average.toFixed(2)}
      </p>
      <AnalyticsLineChart
        title="Installer downloads"
        subtitle="Tracked days only. Untracked days are omitted, not zero."
        series={[{ key: "installer", label: "Installer downloads", color: "#7fd0ef", data: { labels: data.snapshot.downloads.series.labels, values: data.snapshot.downloads.series.installer } }]}
      />
      <MetricTable title="Growth" metrics={data.snapshot.sections.growth?.metrics} />
      <MetricTable title="Retention" metrics={data.snapshot.sections.retention?.metrics} />
      <MetricTable title="Acquisition" metrics={data.snapshot.sections.acquisition?.metrics} />
      <MetricTable title="Clips" metrics={data.snapshot.sections.clips?.metrics} />
      <h3>Games</h3>
      {(data.snapshot.sections.games?.games ?? []).length ? (
        <div className="analytics-table-wrap">
          <table className="analytics-table">
            <thead><tr><th>Game</th><th>Cloud clips</th></tr></thead>
            <tbody>
              {(data.snapshot.sections.games?.games ?? []).map((row) => (
                <tr key={row.slug}><td>{row.name}</td><td>{row.cloudClips}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">No tracked game data for this period. Unknown remains visible when present.</p>
      )}
      <MetricTable title="Features" metrics={data.snapshot.sections.features?.metrics} />
      <h3>Filters</h3>
      {(data.snapshot.sections.features?.filters ?? []).length ? (
        <div className="analytics-table-wrap">
          <table className="analytics-table">
            <thead><tr><th>Filter</th><th>Applications</th></tr></thead>
            <tbody>
              {(data.snapshot.sections.features?.filters ?? []).map((row) => (
                <tr key={row.id ?? row.name}><td>{row.name ?? row.id}</td><td>{row.applications ?? "—"}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">Filter leaderboard omitted: no sufficient live filter events in this snapshot.</p>
      )}
      <MetricTable title="Folders" metrics={data.snapshot.sections.folders?.metrics} />
      <MetricTable title="Sharing" metrics={data.snapshot.sections.sharing?.metrics} />
      <MetricTable title="Revenue" metrics={data.snapshot.sections.revenue?.metrics} />
      <p className="muted">Estimated MRR is an estimate, not revenue.</p>
      <MetricTable title="Infrastructure" metrics={data.snapshot.sections.infrastructure?.metrics} />
      <p className="muted">Bandwidth is not instrumented. Bunny/R2 transfer is not fabricated.</p>
      <MetricTable title="Product Health" metrics={data.snapshot.sections.health?.metrics} />
      <h3>Insights</h3>
      <ul>{data.insights.map((item) => <li key={item.text}>{item.text}</li>)}</ul>
      <h3>Recommendations</h3>
      <ul>{data.recommendations.map((item) => <li key={item.title}><strong>{item.title}</strong> ({item.category}, {item.priority}) — {item.text}</li>)}</ul>
      {!data.recommendations.length ? <p className="muted">No recommendations met the current thresholds.</p> : null}
      <h3>Data coverage</h3>
      <div className="analytics-table-wrap">
        <table className="analytics-table">
          <thead><tr><th>Item</th><th>Status</th><th>Note</th></tr></thead>
          <tbody>
            {data.snapshot.coverage.map((row) => (
              <tr key={row.key}><td>{row.label}</td><td>{row.status}</td><td>{row.note}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted">Error stacks stay on <Link to="/admin/errors">Errors</Link>. Audit history is separate.</p>
    </section>
  );
}
