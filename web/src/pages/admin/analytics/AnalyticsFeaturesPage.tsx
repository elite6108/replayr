import { useEffect, useState } from "react";
import { AnalyticsDateRangePicker } from "../../../components/analytics/AnalyticsDateRangePicker";
import { AnalyticsEmptyState } from "../../../components/analytics/AnalyticsEmptyState";
import { AnalyticsKpiCard } from "../../../components/analytics/AnalyticsKpiCard";
import { fetchAnalyticsFeatures, type AnalyticsFeaturesResponse } from "../../../lib/adminAnalytics";
import { useAuth } from "../../../lib/auth";
import { useAnalyticsQuery } from "./useAnalyticsQuery";

function pct(value: number | null) {
  return value == null ? "—" : `${Math.round(value * 1000) / 10}%`;
}

export function AnalyticsFeaturesPage() {
  const { session } = useAuth();
  const query = useAnalyticsQuery();
  const [data, setData] = useState<AnalyticsFeaturesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = session?.access_token;
    if (!token) return;
    let cancelled = false;
    setLoading(true);
    void fetchAnalyticsFeatures(token, query.search)
      .then((next) => {
        if (!cancelled) {
          setData(next);
          setError(null);
        }
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Could not load features.");
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
          <h2>Features</h2>
          <p className="muted">{data ? data.range.label : "Selected range"} · filters and adoption</p>
        </div>
        <div className="analytics-toolbar">
          <AnalyticsDateRangePicker />
        </div>
      </header>
      {error ? (
        <AnalyticsEmptyState title="Could not load features" body={error} />
      ) : (
        <>
          <div className="admin-stats analytics-kpis">
            {(data?.metrics ?? []).map((kpi) => (
              <AnalyticsKpiCard key={kpi.key} kpi={kpi} loading={loading && !data} />
            ))}
          </div>
          <p className="muted">{data?.powerUsers.note}</p>
          <div className="analytics-table-wrap">
            <table className="analytics-table">
              <thead>
                <tr>
                  <th>Feature</th>
                  <th>Users</th>
                  <th>Events</th>
                  <th>Adoption</th>
                  <th>Repeat</th>
                  <th>DAU?</th>
                </tr>
              </thead>
              <tbody>
                {(data?.features ?? []).map((row) => (
                  <tr key={row.key}>
                    <td>{row.label}</td>
                    <td>{row.uniqueUsers.toLocaleString()}</td>
                    <td>{row.eventCount.toLocaleString()}</td>
                    <td>{pct(row.adoption)}</td>
                    <td>{pct(row.repeatRate)}</td>
                    <td>{row.dau ? "Yes" : "Adoption only"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="analytics-table-wrap">
            <table className="analytics-table">
              <thead>
                <tr>
                  <th>Filter</th>
                  <th>Selected</th>
                  <th>Applied</th>
                  <th>Rendered</th>
                  <th>Shared</th>
                </tr>
              </thead>
              <tbody>
                {(data?.filters ?? []).map((row) => (
                  <tr key={row.id}>
                    <td>{row.used ? row.id : `${row.id} (not counted as used)`}</td>
                    <td>{row.selected.toLocaleString()}</td>
                    <td>{row.applied.toLocaleString()}</td>
                    <td>{row.rendered.toLocaleString()}</td>
                    <td>{row.shared.toLocaleString()}</td>
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
