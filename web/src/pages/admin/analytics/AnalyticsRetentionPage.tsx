import { useEffect, useState } from "react";
import { AnalyticsAvailabilityNotice } from "../../../components/analytics/AnalyticsAvailabilityNotice";
import { AnalyticsDateRangePicker } from "../../../components/analytics/AnalyticsDateRangePicker";
import { AnalyticsEmptyState } from "../../../components/analytics/AnalyticsEmptyState";
import { AnalyticsGranularityControl } from "../../../components/analytics/AnalyticsGranularityControl";
import { AnalyticsLineChart } from "../../../components/analytics/AnalyticsLineChart";
import { fetchAnalyticsRetention, type AnalyticsRetentionResponse } from "../../../lib/adminAnalytics";
import { useAuth } from "../../../lib/auth";
import { useAnalyticsQuery } from "./useAnalyticsQuery";

function cell(value: unknown) {
  if (value == null || value === "") return "—";
  if (typeof value === "number" && value <= 1) return `${Math.round(value * 1000) / 10}%`;
  return String(value);
}

export function AnalyticsRetentionPage() {
  const { session } = useAuth();
  const query = useAnalyticsQuery();
  const [data, setData] = useState<AnalyticsRetentionResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = session?.access_token;
    if (!token) return;
    let cancelled = false;
    setLoading(true);
    void fetchAnalyticsRetention(token, query.search)
      .then((next) => {
        if (!cancelled) {
          setData(next);
          setError(null);
        }
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Could not load retention.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [session?.access_token, query.search]);

  const periods = data?.periods ?? [1, 3, 7, 14, 30, 60, 90];

  return (
    <section className="admin-section analytics-page">
      <header className="admin-header">
        <div>
          <p className="eyebrow">Analytics</p>
          <h2>Retention</h2>
          <p className="muted">{data ? data.range.label : "Selected range"} · exact-day · Monday–Sunday weeks</p>
        </div>
        <div className="analytics-toolbar">
          <AnalyticsDateRangePicker />
          <AnalyticsGranularityControl />
          <label className="analytics-toolbar-block">
            Cohort
            <select value={query.cohort} onChange={(event) => query.setCohort(event.target.value)}>
              <option value="signup">Signup</option>
              <option value="activation">Activation</option>
            </select>
          </label>
        </div>
      </header>
      {error ? (
        <AnalyticsEmptyState title="Could not load retention" body={error} />
      ) : (
        <>
          <div className="analytics-table-wrap">
            <table className="analytics-table">
              <thead>
                <tr>
                  <th>{query.cohort === "activation" ? "Activation" : "Signup"} {data?.range.granularity ?? "week"}</th>
                  <th>Users</th>
                  {periods.map((n) => (
                    <th key={n}>D{n}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(data?.rows ?? []).map((row) => (
                  <tr key={String(row.cohort)}>
                    <td>{String(row.cohort)}</td>
                    <td>{row.users}</td>
                    {periods.map((n) => (
                      <td key={n}>{cell(row[`d${n}`])}</td>
                    ))}
                  </tr>
                ))}
                {loading && !data ? (
                  <tr>
                    <td colSpan={2 + periods.length}>Loading…</td>
                  </tr>
                ) : null}
                {data && data.rows.length === 0 ? (
                  <tr>
                    <td colSpan={2 + periods.length}>No cohorts in this range.</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
          <AnalyticsLineChart
            title="Retention over time"
            subtitle="Immature days are omitted, not shown as 0%."
            series={[
              {
                key: "retention",
                label: "Retained",
                color: "#7fd0ef",
                data: {
                  labels: (data?.curve ?? []).map((item) => `D${item.day}`),
                  values: (data?.curve ?? []).map((item) => item.rate),
                },
              },
            ]}
          />
          <AnalyticsAvailabilityNotice
            message={
              data?.tracking.notice ||
              "Exact calendar day N after the cohort origin. Immature cells are —. Week is Monday–Sunday."
            }
          />
        </>
      )}
    </section>
  );
}
