import { useEffect, useState } from "react";
import { AnalyticsAvailabilityNotice } from "../../../components/analytics/AnalyticsAvailabilityNotice";
import { AnalyticsCompareToggle } from "../../../components/analytics/AnalyticsCompareToggle";
import { AnalyticsDateRangePicker } from "../../../components/analytics/AnalyticsDateRangePicker";
import { AnalyticsEmptyState } from "../../../components/analytics/AnalyticsEmptyState";
import { AnalyticsGranularityControl } from "../../../components/analytics/AnalyticsGranularityControl";
import { AnalyticsKpiCard } from "../../../components/analytics/AnalyticsKpiCard";
import { AnalyticsLineChart } from "../../../components/analytics/AnalyticsLineChart";
import { comparisonCaption, fetchAnalyticsOverview, type AnalyticsOverviewResponse } from "../../../lib/adminAnalytics";
import { useAuth } from "../../../lib/auth";
import { useAnalyticsQuery } from "./useAnalyticsQuery";

export function AnalyticsOverviewPage() {
  const { session } = useAuth();
  const query = useAnalyticsQuery();
  const [data, setData] = useState<AnalyticsOverviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = session?.access_token;
    if (!token) return;
    let cancelled = false;
    setLoading(true);
    void fetchAnalyticsOverview(token, query.search)
      .then((next) => {
        if (!cancelled) {
          setData(next);
          setError(null);
        }
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Could not load overview.");
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
          <h2>Overview</h2>
          <p className="muted">
            {data ? data.range.label : "Selected range"}
            {comparisonCaption(data?.comparisonRange ?? null)}
          </p>
        </div>
        <div className="analytics-toolbar">
          <AnalyticsDateRangePicker />
          <AnalyticsGranularityControl />
          <AnalyticsCompareToggle />
        </div>
      </header>
      {error ? (
        <AnalyticsEmptyState title="Could not load analytics" body={error} />
      ) : (
        <>
          <div className="admin-stats analytics-kpis">
            {(data?.metrics ?? Array.from({ length: 8 }, (_, index) => ({
              key: `s${index}`,
              label: "Loading",
              value: null,
              previous: null,
              absoluteChange: null,
              percentageChange: null,
              availability: "AVAILABLE",
            }))).map((kpi) => (
              <AnalyticsKpiCard key={kpi.key} kpi={kpi} loading={loading && !data} />
            ))}
          </div>
          <AnalyticsLineChart
            title="Replayr Growth"
            subtitle={data?.range.label}
            series={[
              { key: "new_users", label: "New Users", color: "#7fd0ef", data: data?.series.new_users ?? { labels: [], values: [] } },
              {
                key: "cloud_activated_users",
                label: "Cloud Activations",
                color: "#8ed9a4",
                data: data?.series.cloud_activated_users ?? { labels: [], values: [] },
              },
            ]}
          />
          <p className="muted analytics-freshness">
            {data?.lastUpdated
              ? `Last updated ${new Date(data.lastUpdated).toLocaleString()} · hourly rollup`
              : "Last updated — · hourly rollup"}
          </p>
          <AnalyticsAvailabilityNotice message="True DAU, WAU, MAU, and activation live on Analytics → Growth. Historical cloud-activated remains a proxy here." />
        </>
      )}
    </section>
  );
}
