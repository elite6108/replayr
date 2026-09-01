import { useEffect, useState } from "react";
import { AnalyticsAvailabilityNotice } from "../../../components/analytics/AnalyticsAvailabilityNotice";
import { AnalyticsCompareToggle } from "../../../components/analytics/AnalyticsCompareToggle";
import { AnalyticsDateRangePicker } from "../../../components/analytics/AnalyticsDateRangePicker";
import { AnalyticsEmptyState } from "../../../components/analytics/AnalyticsEmptyState";
import { AnalyticsGranularityControl } from "../../../components/analytics/AnalyticsGranularityControl";
import { AnalyticsKpiCard } from "../../../components/analytics/AnalyticsKpiCard";
import { AnalyticsLineChart } from "../../../components/analytics/AnalyticsLineChart";
import { comparisonCaption, fetchAnalyticsGrowth, type AnalyticsGrowthResponse } from "../../../lib/adminAnalytics";
import { useAuth } from "../../../lib/auth";
import { useAnalyticsQuery } from "./useAnalyticsQuery";

function pct(value: number | null) {
  return value == null ? "—" : `${Math.round(value * 1000) / 10}%`;
}

export function AnalyticsGrowthPage() {
  const { session } = useAuth();
  const query = useAnalyticsQuery();
  const [data, setData] = useState<AnalyticsGrowthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = session?.access_token;
    if (!token) return;
    let cancelled = false;
    setLoading(true);
    void fetchAnalyticsGrowth(token, query.search)
      .then((next) => {
        if (!cancelled) {
          setData(next);
          setError(null);
        }
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Could not load growth.");
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
        <AnalyticsEmptyState title="Could not load growth" body={error} />
      ) : (
        <>
          <div className="admin-stats analytics-kpis">
            {(data?.metrics ?? Array.from({ length: 11 }, (_, index) => ({
              key: `g${index}`,
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
          {data?.insights?.length ? (
            <ul className="analytics-insights">
              {data.insights.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : null}
          <AnalyticsLineChart
            title="Active users"
            subtitle="DAU is unique users that day. WAU/MAU are rolling unique users, not summed DAU."
            series={[
              { key: "dau", label: "DAU", color: "#7fd0ef", data: { labels: data?.series.labels ?? [], values: data?.series.dau ?? [] } },
              { key: "wau", label: "WAU", color: "#8ed9a4", data: { labels: data?.series.labels ?? [], values: data?.series.wau ?? [] } },
              { key: "mau", label: "MAU", color: "#f0c27a", data: { labels: data?.series.labels ?? [], values: data?.series.mau ?? [] } },
            ]}
          />
          <div className="analytics-breakdown">
            <section>
              <h3>Activation funnel</h3>
              {(data?.funnel ?? []).map((stage) => (
                <p key={stage.name}>
                  <strong>{stage.name}</strong>
                  {" · "}
                  {stage.count == null ? "Unavailable" : stage.count.toLocaleString()}
                  {stage.count != null ? ` · ${pct(stage.fromPrevious)} from previous · ${pct(stage.fromFirst)} of signups` : ""}
                </p>
              ))}
            </section>
            <section>
              <h3>Download funnel</h3>
              <p className="muted">{data?.downloadFunnel.note}</p>
              {(data?.downloadFunnel.stages ?? []).map((stage) => (
                <p key={stage.name}>
                  <strong>{stage.name}</strong>
                  {" · "}
                  {stage.count == null ? "Unavailable" : stage.count.toLocaleString()}
                </p>
              ))}
            </section>
            <section>
              <h3>Time to activation</h3>
              <p>Exact clip.saved users only: {data?.timing.n ?? 0}</p>
              <p>Median {data?.timing.medianLabel ?? "—"} · p25 {data?.timing.p25Label ?? "—"} · p75 {data?.timing.p75Label ?? "—"}</p>
            </section>
            <section>
              <h3>New vs returning</h3>
              <p>New active {data?.newVsReturning.newActive ?? "—"} · Returning {data?.newVsReturning.returningActive ?? "—"}</p>
              <p className="muted">New active is first qualifying activity, not signup.</p>
            </section>
          </div>
          <p className="muted analytics-freshness">
            {data?.lastUpdated
              ? `Last updated ${new Date(data.lastUpdated).toLocaleString()} · hourly rollup`
              : "Last updated — · hourly rollup"}
          </p>
          <AnalyticsAvailabilityNotice
            message={
              data
                ? `Qualifying activity began ${data.tracking.activityAvailableFrom}. WAU needs 7 tracked days (${data.tracking.wauAvailableFrom}). MAU needs 30 (${data.tracking.mauAvailableFrom}). capture.started and replay.enabled do not count as DAU.`
                : "Loading availability…"
            }
          />
        </>
      )}
    </section>
  );
}
