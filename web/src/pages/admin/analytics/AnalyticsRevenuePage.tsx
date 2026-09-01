import { useEffect, useState } from "react";
import { AnalyticsAvailabilityNotice } from "../../../components/analytics/AnalyticsAvailabilityNotice";
import { AnalyticsCompareToggle } from "../../../components/analytics/AnalyticsCompareToggle";
import { AnalyticsDateRangePicker } from "../../../components/analytics/AnalyticsDateRangePicker";
import { AnalyticsEmptyState } from "../../../components/analytics/AnalyticsEmptyState";
import { AnalyticsGranularityControl } from "../../../components/analytics/AnalyticsGranularityControl";
import { AnalyticsKpiCard } from "../../../components/analytics/AnalyticsKpiCard";
import { AnalyticsLineChart } from "../../../components/analytics/AnalyticsLineChart";
import { comparisonCaption, fetchAnalyticsRevenue, type AnalyticsKpi, type AnalyticsRevenueResponse } from "../../../lib/adminAnalytics";
import { useAuth } from "../../../lib/auth";
import { useAnalyticsQuery } from "./useAnalyticsQuery";

function pct(value: number | null) {
  return value == null ? "—" : `${Math.round(value * 1000) / 10}%`;
}

function visibleKpis(metrics: AnalyticsKpi[] | undefined) {
  return (metrics ?? []).filter((kpi) => kpi.availability !== "NOT_INSTRUMENTED");
}

export function AnalyticsRevenuePage() {
  const { session } = useAuth();
  const query = useAnalyticsQuery();
  const [data, setData] = useState<AnalyticsRevenueResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = session?.access_token;
    if (!token) return;
    let cancelled = false;
    setLoading(true);
    void fetchAnalyticsRevenue(token, query.search)
      .then((next) => {
        if (!cancelled) {
          setData(next);
          setError(null);
        }
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Could not load revenue.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [session?.access_token, query.search]);

  const kpis = visibleKpis(data?.metrics);

  return (
    <section className="admin-section analytics-page">
      <header className="admin-header">
        <div>
          <p className="eyebrow">Analytics</p>
          <h2>Revenue</h2>
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
        <AnalyticsEmptyState title="Could not load revenue" body={error} />
      ) : (
        <>
          <p className="muted">
            Paid is an active or trialing Stripe subscription. Complimentary grants are separate. Estimated MRR is not
            Revenue.
          </p>
          <div className="admin-stats analytics-kpis">
            {(kpis.length ? kpis : Array.from({ length: 8 }, (_, index) => ({
              key: `r${index}`,
              label: "Loading",
              value: null,
              previous: null,
              absoluteChange: null,
              percentageChange: null,
              availability: "INCOMPLETE",
              badge: "estimate" as const,
            }))).map((kpi) => (
              <AnalyticsKpiCard key={kpi.key} kpi={kpi} loading={loading && !data} />
            ))}
          </div>
          <AnalyticsLineChart
            title="Subscriptions"
            subtitle="Paid subscribers and estimated MRR. Cancellations are access ended, not cancel-at-period-end."
            series={[
              { key: "paid", label: "Paid Subscribers", color: "#7fd0ef", data: { labels: data?.series.labels ?? [], values: data?.series.paid ?? [] } },
              { key: "mrr", label: "Estimated MRR (cents)", color: "#8ed9a4", data: { labels: data?.series.labels ?? [], values: data?.series.mrr ?? [] } },
              { key: "newPaid", label: "New Paid", color: "#f0c27a", data: { labels: data?.series.labels ?? [], values: data?.series.newPaid ?? [] } },
              { key: "cancelled", label: "Cancellations", color: "#ff8a8a", data: { labels: data?.series.labels ?? [], values: data?.series.cancelled ?? [] } },
            ]}
          />
          <div className="analytics-breakdown">
            <section>
              <h3>Access snapshot</h3>
              <p>Paid {data?.snapshot.paid ?? "—"} · Complimentary {data?.snapshot.complimentary ?? "—"} · Premium {data?.snapshot.premium ?? "—"}</p>
              <p>Scheduled to cancel {data?.snapshot.scheduledToCancel ?? "—"} · Past due {data?.snapshot.pastDue ?? "—"}</p>
              <p>Cancelled {data?.snapshot.cancelled ?? "—"} · Expired {data?.snapshot.expired ?? "—"} · Reactivations {data?.reactivations ?? "—"}</p>
            </section>
            <section>
              <h3>Free → paid cohorts</h3>
              <p className="muted">{data?.conversion.note}</p>
              <p>Signup → paid 7d {pct(data?.conversion.signup7d ?? null)}</p>
              <p>Activation → paid 7d {pct(data?.conversion.activation7d ?? null)}</p>
              <p>Activation → paid 30d {pct(data?.conversion.activation30d ?? null)}</p>
            </section>
            <section>
              <h3>Checkout funnel</h3>
              {(data?.funnel ?? []).map((stage) => (
                <p key={stage.name}>
                  <strong>{stage.name}</strong>
                  {" · "}
                  {stage.count == null ? "Unavailable" : stage.count.toLocaleString()}
                  {stage.availability !== "AVAILABLE" ? ` · ${stage.availability}` : ""}
                </p>
              ))}
            </section>
            <section>
              <h3>Estimated MRR</h3>
              <p>
                ${(data ? data.mrr.estimatedCents / 100 : 0).toFixed(2)}
                {" · "}
                {data?.mrr.allAuthoritative ? "Stripe amounts present" : "Estimate from plan prices"}
              </p>
              <p className="muted">{data?.definitions.mrr}</p>
            </section>
          </div>
          <div className="analytics-table-wrap">
            <table className="analytics-table">
              <thead>
                <tr>
                  <th>Behavior</th>
                  <th>Users</th>
                  <th>Paid</th>
                  <th>Observed conversion</th>
                </tr>
              </thead>
              <tbody>
                {(data?.correlations ?? []).map((row) => (
                  <tr key={row.key}>
                    <td>{row.label}</td>
                    <td>{row.users.toLocaleString()}</td>
                    <td>{row.paid.toLocaleString()}</td>
                    <td>{row.rate == null ? row.note : `${pct(row.rate)} · not causation`}</td>
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
          <AnalyticsAvailabilityNotice message="Pre-instrumentation billing history is incomplete. cancel_at_period_end is scheduled, not churned. Complimentary grants are not paid subscribers." />
        </>
      )}
    </section>
  );
}
