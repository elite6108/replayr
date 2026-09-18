import { useEffect, useState } from "react";
import { AnalyticsCompareToggle } from "../../../components/analytics/AnalyticsCompareToggle";
import { AnalyticsDateRangePicker } from "../../../components/analytics/AnalyticsDateRangePicker";
import { AnalyticsEmptyState } from "../../../components/analytics/AnalyticsEmptyState";
import { AnalyticsGranularityControl } from "../../../components/analytics/AnalyticsGranularityControl";
import { AnalyticsKpiCard } from "../../../components/analytics/AnalyticsKpiCard";
import { AnalyticsLineChart } from "../../../components/analytics/AnalyticsLineChart";
import { comparisonCaption, fetchAnalyticsTraffic, type AnalyticsTrafficResponse } from "../../../lib/adminAnalytics";
import { useAuth } from "../../../lib/auth";
import { useAnalyticsQuery } from "./useAnalyticsQuery";

function SliceTable({ title, rows }: { title: string; rows: Array<{ key: string; uniqueVisitors: number; pings: number }> }) {
  return (
    <section>
      <h3>{title}</h3>
      {rows.length === 0 ? (
        <p className="muted">No traffic in this range yet.</p>
      ) : (
        <div className="live-table-wrap">
          <table className="live-table">
            <thead>
              <tr>
                <th>{title}</th>
                <th>Uniques</th>
                <th>Pings</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key}>
                  <td className="live-path">{row.key}</td>
                  <td className="live-mono">{row.uniqueVisitors.toLocaleString()}</td>
                  <td className="live-mono">{row.pings.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function AnalyticsTrafficPage() {
  const { session } = useAuth();
  const query = useAnalyticsQuery();
  const [data, setData] = useState<AnalyticsTrafficResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = session?.access_token;
    if (!token) return;
    let cancelled = false;
    setLoading(true);
    void fetchAnalyticsTraffic(token, query.search)
      .then((next) => {
        if (!cancelled) {
          setData(next);
          setError(null);
        }
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Could not load visitor traffic.");
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
          <h2>Visitor traffic</h2>
          <p className="muted">
            {data ? data.range.label : "Selected range"}
            {comparisonCaption(data?.comparisonRange ?? null)}
            {" · "}
            {data?.note ?? "Hourly unique visitors without IPs."}
          </p>
        </div>
        <div className="analytics-toolbar">
          <AnalyticsDateRangePicker />
          <AnalyticsGranularityControl allowHour />
          <AnalyticsCompareToggle />
        </div>
      </header>
      {error ? (
        <AnalyticsEmptyState title="Could not load visitor traffic" body={error} />
      ) : (
        <>
          <div className="admin-stats analytics-kpis">
            {(data?.metrics ?? Array.from({ length: 3 }, (_, index) => ({
              key: `t${index}`,
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
          <AnalyticsLineChart
            title="Unique visitors"
            subtitle="A visitor is counted once per hour. Compare days with Day, or times of day with Hour."
            series={[
              {
                key: "unique",
                label: "Unique visitors",
                color: "#7fd0ef",
                data: { labels: data?.series.labels ?? [], values: data?.series.uniqueVisitors ?? [] },
              },
              {
                key: "signed",
                label: "Signed-in",
                color: "#8ed9a4",
                data: { labels: data?.series.labels ?? [], values: data?.series.signedIn ?? [] },
              },
            ]}
          />
          <AnalyticsLineChart
            title="Presence pings"
            subtitle="Heartbeats in each bucket. Useful when unique visitors are still a small count."
            series={[
              {
                key: "pings",
                label: "Pings",
                color: "#c4b5fd",
                data: { labels: data?.series.labels ?? [], values: data?.series.pings ?? [] },
              },
            ]}
          />
          <AnalyticsLineChart
            title="Hour of day"
            subtitle="Unique visitors in each local hour across the selected range."
            series={[
              {
                key: "hour-unique",
                label: "Unique visitors",
                color: "#f0c27a",
                data: { labels: data?.series.hourLabels ?? [], values: data?.series.hourUniques ?? [] },
              },
            ]}
          />
          <div className="analytics-breakdown">
            <SliceTable title="Surface" rows={data?.breakdown.surfaces ?? []} />
            <SliceTable title="Country" rows={data?.breakdown.countries ?? []} />
            <SliceTable title="Path" rows={data?.breakdown.paths ?? []} />
          </div>
        </>
      )}
    </section>
  );
}
