import { useEffect, useState } from "react";
import { AnalyticsAvailabilityNotice } from "../../../components/analytics/AnalyticsAvailabilityNotice";
import { AnalyticsDateRangePicker } from "../../../components/analytics/AnalyticsDateRangePicker";
import { AnalyticsEmptyState } from "../../../components/analytics/AnalyticsEmptyState";
import { AnalyticsKpiCard } from "../../../components/analytics/AnalyticsKpiCard";
import { AnalyticsLineChart } from "../../../components/analytics/AnalyticsLineChart";
import { fetchAnalyticsSharing, type AnalyticsSharingResponse } from "../../../lib/adminAnalytics";
import { useAuth } from "../../../lib/auth";
import { useAnalyticsQuery } from "./useAnalyticsQuery";

function pct(value: number | null) {
  return value == null ? "—" : `${Math.round(value * 1000) / 10}%`;
}

export function AnalyticsSharingPage() {
  const { session } = useAuth();
  const query = useAnalyticsQuery();
  const [data, setData] = useState<AnalyticsSharingResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = session?.access_token;
    if (!token) return;
    let cancelled = false;
    setLoading(true);
    void fetchAnalyticsSharing(token, query.search)
      .then((next) => {
        if (!cancelled) {
          setData(next);
          setError(null);
        }
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Could not load sharing.");
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
          <h2>Sharing</h2>
          <p className="muted">{data ? data.range.label : "Selected range"}</p>
        </div>
        <div className="analytics-toolbar">
          <AnalyticsDateRangePicker />
        </div>
      </header>
      <AnalyticsAvailabilityNotice message="Share → installer is not identity-stitched. Public views and downloads are period-level." />
      {error ? (
        <AnalyticsEmptyState title="Could not load sharing" body={error} />
      ) : (
        <>
          <div className="admin-stats analytics-kpis">
            {(data?.metrics ?? []).map((kpi) => (
              <AnalyticsKpiCard key={kpi.key} kpi={kpi} loading={loading && !data} />
            ))}
          </div>
          <p className="muted">
            {data?.conversion.note} Views → public download: {pct(data?.conversion.viewsToPublicDownload ?? null)}.
          </p>
          <AnalyticsLineChart
            title="Shares and views"
            subtitle="Shares need clip.shared. Views come from clip_daily_views."
            series={[
              { key: "shares", label: "Shares", color: "#c9b6ff", data: { labels: data?.series.labels ?? [], values: data?.series.shares ?? [] } },
              { key: "views", label: "Public views", color: "#7fd0ef", data: { labels: data?.series.labels ?? [], values: data?.series.views ?? [] } },
            ]}
          />
        </>
      )}
    </section>
  );
}
