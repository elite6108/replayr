import { useEffect, useState } from "react";
import { AnalyticsCompareToggle } from "../../../components/analytics/AnalyticsCompareToggle";
import { AnalyticsDateRangePicker } from "../../../components/analytics/AnalyticsDateRangePicker";
import { AnalyticsEmptyState } from "../../../components/analytics/AnalyticsEmptyState";
import { AnalyticsGranularityControl } from "../../../components/analytics/AnalyticsGranularityControl";
import { AnalyticsKpiCard } from "../../../components/analytics/AnalyticsKpiCard";
import { AnalyticsLineChart } from "../../../components/analytics/AnalyticsLineChart";
import { fetchAnalyticsClips, type AnalyticsClipsResponse } from "../../../lib/adminAnalytics";
import { useAuth } from "../../../lib/auth";
import { useAnalyticsQuery } from "./useAnalyticsQuery";

export function AnalyticsClipsPage() {
  const { session } = useAuth();
  const query = useAnalyticsQuery();
  const [data, setData] = useState<AnalyticsClipsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = session?.access_token;
    if (!token) return;
    let cancelled = false;
    setLoading(true);
    void fetchAnalyticsClips(token, query.search)
      .then((next) => {
        if (!cancelled) {
          setData(next);
          setError(null);
        }
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Could not load clips.");
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
          <h2>Clips</h2>
          <p className="muted">{data ? data.range.label : "Selected range"}</p>
        </div>
        <div className="analytics-toolbar">
          <AnalyticsDateRangePicker />
          <AnalyticsGranularityControl />
          <AnalyticsCompareToggle />
        </div>
      </header>
      {error ? (
        <AnalyticsEmptyState title="Could not load clips" body={error} />
      ) : (
        <>
          <div className="admin-stats analytics-kpis">
            {(data?.metrics ?? []).map((kpi) => (
              <AnalyticsKpiCard key={kpi.key} kpi={kpi} loading={loading && !data} />
            ))}
          </div>
          <AnalyticsLineChart
            title="Clips created"
            subtitle="Local saves are clip.saved. Ready cloud clips come from the clips table."
            series={[
              { key: "saved", label: "Saved", color: "#7fd0ef", data: { labels: data?.series.labels ?? [], values: data?.series.clips_saved ?? [] } },
              { key: "ready", label: "Ready cloud", color: "#8ed9a4", data: { labels: data?.series.labels ?? [], values: data?.series.ready_cloud_clips ?? [] } },
            ]}
          />
          <div className="analytics-breakdown">
            <section>
              <h3>Clips per user</h3>
              {(data?.distributions.clipsPerUser ?? []).map((row) => (
                <p key={row.key}>
                  <strong>{row.key}</strong>
                  {" · "}
                  {row.count.toLocaleString()}
                </p>
              ))}
            </section>
            <section>
              <h3>Duration</h3>
              {(data?.distributions.duration ?? []).map((row) => (
                <p key={row.key}>
                  <strong>{row.key}</strong>
                  {" · "}
                  {row.count.toLocaleString()}
                </p>
              ))}
            </section>
            <section>
              <h3>Visibility</h3>
              <p>Public · {data?.distributions.visibility.public ?? 0}</p>
              <p>Unlisted · {data?.distributions.visibility.unlisted ?? 0}</p>
              <p>Private · {data?.distributions.visibility.private ?? 0}</p>
            </section>
            <section>
              <h3>Power users</h3>
              <p>{data?.powerUsers.note}</p>
              <p>
                {data?.powerUsers.count ?? 0} users
                {data?.powerUsers.paidShare != null ? ` · ${Math.round(data.powerUsers.paidShare * 1000) / 10}% paid` : ""}
              </p>
            </section>
          </div>
        </>
      )}
    </section>
  );
}
