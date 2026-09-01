import { useEffect, useState } from "react";
import { AnalyticsDateRangePicker } from "../../../components/analytics/AnalyticsDateRangePicker";
import { AnalyticsEmptyState } from "../../../components/analytics/AnalyticsEmptyState";
import { AnalyticsKpiCard } from "../../../components/analytics/AnalyticsKpiCard";
import { fetchAnalyticsGames, type AnalyticsGamesResponse } from "../../../lib/adminAnalytics";
import { useAuth } from "../../../lib/auth";
import { useAnalyticsQuery } from "./useAnalyticsQuery";

function pct(value: number | null) {
  return value == null ? "—" : `${Math.round(value * 1000) / 10}%`;
}

export function AnalyticsGamesPage() {
  const { session } = useAuth();
  const query = useAnalyticsQuery();
  const [data, setData] = useState<AnalyticsGamesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = session?.access_token;
    if (!token) return;
    let cancelled = false;
    setLoading(true);
    void fetchAnalyticsGames(token, query.search)
      .then((next) => {
        if (!cancelled) {
          setData(next);
          setError(null);
        }
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Could not load games.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [session?.access_token, query.search]);

  return (
    <section className="admin-section analytics-page">
      <header className="admin-header">
        <div>
          <p className="eyebrow">Analytics</p>
          <h2>Games</h2>
          <p className="muted">{data ? data.range.label : "Selected range"} · normalized game slugs</p>
        </div>
        <div className="analytics-toolbar">
          <AnalyticsDateRangePicker />
        </div>
      </header>
      {error ? (
        <AnalyticsEmptyState title="Could not load games" body={error} />
      ) : (
        <>
          <div className="admin-stats analytics-kpis">
            {(data?.metrics ?? []).map((kpi) => (
              <AnalyticsKpiCard key={kpi.key} kpi={kpi} loading={loading && !data} />
            ))}
          </div>
          {data?.insights?.length ? (
            <ul className="analytics-insights">
              {data.insights.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : null}
          <div className="analytics-table-wrap">
            <table className="analytics-table">
              <thead>
                <tr>
                  <th>Game</th>
                  <th>Cloud clips</th>
                  <th>Uploaders</th>
                  <th>Views</th>
                  <th>Local saves</th>
                  <th>D7</th>
                </tr>
              </thead>
              <tbody>
                {(data?.games ?? []).map((row) => (
                  <tr key={row.slug}>
                    <td>{row.name}</td>
                    <td>{row.cloudClips.toLocaleString()}</td>
                    <td>{row.uniqueUploaders.toLocaleString()}</td>
                    <td>{row.publicViews.toLocaleString()}</td>
                    <td>{row.clipsSaved == null ? "—" : row.clipsSaved.toLocaleString()}</td>
                    <td>{pct(row.retentionD7)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
