import { Link } from "react-router-dom";
import { useEffect, useState } from "react";
import { AnalyticsAvailabilityNotice } from "../../../components/analytics/AnalyticsAvailabilityNotice";
import { AnalyticsCompareToggle } from "../../../components/analytics/AnalyticsCompareToggle";
import { AnalyticsDateRangePicker } from "../../../components/analytics/AnalyticsDateRangePicker";
import { AnalyticsEmptyState } from "../../../components/analytics/AnalyticsEmptyState";
import { AnalyticsGranularityControl } from "../../../components/analytics/AnalyticsGranularityControl";
import { AnalyticsKpiCard } from "../../../components/analytics/AnalyticsKpiCard";
import { AnalyticsLineChart } from "../../../components/analytics/AnalyticsLineChart";
import { fetchAnalyticsHealth, type AnalyticsHealthResponse, type AnalyticsKpi } from "../../../lib/adminAnalytics";
import { useAuth } from "../../../lib/auth";
import { useAnalyticsQuery } from "./useAnalyticsQuery";

function pct(value: number | null) {
  return value == null ? "—" : `${Math.round(value * 1000) / 10}%`;
}

function visible(metrics: AnalyticsKpi[] | undefined) {
  return (metrics ?? []).filter((kpi) => kpi.availability !== "NOT_INSTRUMENTED");
}

export function AnalyticsHealthPage() {
  const { session } = useAuth();
  const query = useAnalyticsQuery();
  const [data, setData] = useState<AnalyticsHealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = session?.access_token;
    if (!token) return;
    let cancelled = false;
    setLoading(true);
    void fetchAnalyticsHealth(token, query.search)
      .then((next) => {
        if (!cancelled) {
          setData(next);
          setError(null);
        }
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Could not load product health.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [session?.access_token, query.search]);

  const kpis = visible(data?.metrics);

  return (
    <section className="admin-section analytics-page">
      <header className="admin-header">
        <div>
          <p className="eyebrow">Analytics</p>
          <h2>Product Health</h2>
          <p className="muted">{data ? data.range.label : "Selected range"} · save, upload, render, and errors</p>
        </div>
        <div className="analytics-toolbar">
          <AnalyticsDateRangePicker />
          <AnalyticsGranularityControl />
          <AnalyticsCompareToggle />
        </div>
      </header>
      {error ? (
        <AnalyticsEmptyState title="Could not load product health" body={error} />
      ) : (
        <>
          {data?.attention.length ? (
            <div className="analytics-insights">
              <h3>Needs attention</h3>
              <ul>
                {data.attention.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="admin-stats analytics-kpis">
            {(kpis.length ? kpis : Array.from({ length: 7 }, (_, index) => ({
              key: `h${index}`,
              label: "Loading",
              value: null,
              previous: null,
              absoluteChange: null,
              percentageChange: null,
              availability: "INCOMPLETE",
            }))).map((kpi) => (
              <AnalyticsKpiCard key={kpi.key} kpi={kpi} loading={loading && !data} />
            ))}
          </div>
          {data?.insights.length ? (
            <ul className="analytics-insights">
              {data.insights.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : null}
          <AnalyticsLineChart
            title="Failures"
            subtitle="Save and upload failures plus grouped error_events. Playback and download failures are not instrumented."
            series={[
              { key: "save", label: "Save failed", color: "#f0c27a", data: { labels: data?.series.labels ?? [], values: data?.series.saveFailed ?? [] } },
              { key: "upload", label: "Upload failed", color: "#ff8a8a", data: { labels: data?.series.labels ?? [], values: data?.series.uploadFailed ?? [] } },
              { key: "errors", label: "Error groups", color: "#7fd0ef", data: { labels: data?.series.labels ?? [], values: data?.series.errors ?? [] } },
            ]}
          />
          <div className="analytics-table-wrap">
            <table className="analytics-table">
              <thead>
                <tr>
                  <th>Version</th>
                  <th>Saves</th>
                  <th>Save success</th>
                  <th>Uploads</th>
                  <th>Upload success</th>
                  <th>Renders</th>
                  <th>Render success</th>
                  <th>Errors</th>
                </tr>
              </thead>
              <tbody>
                {(data?.releases ?? []).map((row) => (
                  <tr key={row.version}>
                    <td>
                      {row.version}
                      {row.potentialRegression ? " · potential regression" : ""}
                    </td>
                    <td>{row.clipSaves.toLocaleString()}</td>
                    <td>{pct(row.saveSuccess)}</td>
                    <td>{row.uploads.toLocaleString()}</td>
                    <td>{pct(row.uploadSuccess)}</td>
                    <td>{row.renders.toLocaleString()}</td>
                    <td>{pct(row.renderSuccess)}</td>
                    <td>{row.errors.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted">{data?.definitions.regression}</p>
          <div className="analytics-table-wrap">
            <table className="analytics-table">
              <thead>
                <tr>
                  <th>Platform</th>
                  <th>Save success</th>
                  <th>Upload success</th>
                  <th>Render success</th>
                  <th>Errors</th>
                </tr>
              </thead>
              <tbody>
                {(data?.platforms ?? []).map((row) => (
                  <tr key={row.platform}>
                    <td>{row.platform}</td>
                    <td>{pct(row.clipSaveSuccess)}</td>
                    <td>{pct(row.uploadSuccess)}</td>
                    <td>{pct(row.renderSuccess)}</td>
                    <td>{row.errors.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted">{data?.games.note}</p>
          <p className="muted">{data?.features.note}</p>
          <div className="analytics-table-wrap">
            <table className="analytics-table">
              <thead>
                <tr>
                  <th>Error group</th>
                  <th>Count</th>
                  <th>Status</th>
                  <th>Last seen</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {(data?.errors ?? []).map((row) => (
                  <tr key={row.fingerprint}>
                    <td>{row.message}</td>
                    <td>{row.occurrences.toLocaleString()}</td>
                    <td>{row.status}</td>
                    <td>{new Date(row.lastSeenAt).toLocaleString()}</td>
                    <td><Link to={row.href}>View error details</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted analytics-freshness">
            {data?.lastUpdated
              ? `Last updated ${new Date(data.lastUpdated).toLocaleString()} · hourly rollup`
              : "Last updated — · hourly rollup"}
          </p>
          <AnalyticsAvailabilityNotice message="Clip save and render rates stay incomplete until desktop events mature. Upload success is available. Stacks stay on Errors." />
        </>
      )}
    </section>
  );
}
