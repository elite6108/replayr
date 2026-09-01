import { useEffect, useState } from "react";
import { AnalyticsAvailabilityNotice } from "../../../components/analytics/AnalyticsAvailabilityNotice";
import { AnalyticsCompareToggle } from "../../../components/analytics/AnalyticsCompareToggle";
import { AnalyticsDateRangePicker } from "../../../components/analytics/AnalyticsDateRangePicker";
import { AnalyticsEmptyState } from "../../../components/analytics/AnalyticsEmptyState";
import { fetchAnalyticsAcquisition, type AnalyticsAcquisitionResponse } from "../../../lib/adminAnalytics";
import { useAuth } from "../../../lib/auth";
import { useAnalyticsQuery } from "./useAnalyticsQuery";

function pct(value: number | null) {
  return value == null ? "—" : `${Math.round(value * 1000) / 10}%`;
}

export function AnalyticsAcquisitionPage() {
  const { session } = useAuth();
  const query = useAnalyticsQuery();
  const [data, setData] = useState<AnalyticsAcquisitionResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = session?.access_token;
    if (!token) return;
    let cancelled = false;
    void fetchAnalyticsAcquisition(token, query.search)
      .then((next) => {
        if (!cancelled) {
          setData(next);
          setError(null);
        }
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Could not load acquisition.");
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
          <h2>Acquisition</h2>
          <p className="muted">{data ? data.range.label : "Selected range"}</p>
        </div>
        <div className="analytics-toolbar">
          <AnalyticsDateRangePicker />
          <AnalyticsCompareToggle />
        </div>
      </header>
      {error ? (
        <AnalyticsEmptyState title="Could not load acquisition" body={error} />
      ) : (
        <>
          <div className="analytics-breakdown">
            <section>
              <h3>Attribution coverage</h3>
              <p>
                {data?.coverage.attributed ?? 0} of {data?.coverage.newUsers ?? 0} new users attributed
                {" · "}
                {pct(data?.coverage.rate ?? null)}
              </p>
              <p>Unknown {data?.coverage.unknown ?? 0} · Direct {data?.coverage.direct ?? 0}</p>
              <p className="muted">{data?.coverage.note}</p>
            </section>
            <section>
              <h3>Download → signup</h3>
              <p>
                {data?.conversion.label === "user-level"
                  ? `User-level ${pct(data.conversion.userLevel)}`
                  : `Period-level ratio ${pct(data?.conversion.periodLevel ?? null)}`}
              </p>
              <p className="muted">{data?.conversion.note}</p>
            </section>
          </div>
          <div className="analytics-table-wrap">
            <table className="analytics-table">
              <thead>
                <tr>
                  <th>Source</th>
                  <th>Signups</th>
                  <th>Activated</th>
                  <th>Activation rate</th>
                  <th>Share of all new users</th>
                </tr>
              </thead>
              <tbody>
                {(data?.sources ?? []).map((row) => (
                  <tr key={row.source}>
                    <td>{row.label}</td>
                    <td>{row.signups}</td>
                    <td>{row.activated}</td>
                    <td>{pct(row.activationRate)}</td>
                    <td>{pct(row.shareOfAll)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <AnalyticsAvailabilityNotice message="Source charts include Unknown so attributed users are not treated as the whole population. No fingerprinting." />
        </>
      )}
    </section>
  );
}
