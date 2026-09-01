import { useEffect, useState } from "react";
import { AnalyticsAvailabilityNotice } from "../../../components/analytics/AnalyticsAvailabilityNotice";
import { AnalyticsCompareToggle } from "../../../components/analytics/AnalyticsCompareToggle";
import { AnalyticsDateRangePicker } from "../../../components/analytics/AnalyticsDateRangePicker";
import { AnalyticsEmptyState } from "../../../components/analytics/AnalyticsEmptyState";
import { AnalyticsGranularityControl } from "../../../components/analytics/AnalyticsGranularityControl";
import { AnalyticsKpiCard } from "../../../components/analytics/AnalyticsKpiCard";
import { AnalyticsLineChart } from "../../../components/analytics/AnalyticsLineChart";
import {
  fetchAnalyticsInfrastructure,
  patchAnalyticsCostAssumption,
  type AnalyticsInfrastructureResponse,
  type AnalyticsKpi,
} from "../../../lib/adminAnalytics";
import { useAuth } from "../../../lib/auth";
import { formatBytes } from "../../../lib/format";
import { useAnalyticsQuery } from "./useAnalyticsQuery";

function visibleKpis(metrics: AnalyticsKpi[] | undefined) {
  return (metrics ?? []).filter((kpi) => kpi.availability !== "NOT_INSTRUMENTED");
}

function money(cents: number | null | undefined) {
  return cents == null ? "—" : `$${(cents / 100).toFixed(2)}`;
}

function pct(value: number | null) {
  return value == null ? "—" : `${Math.round(value * 1000) / 10}%`;
}

export function AnalyticsInfrastructurePage() {
  const { session } = useAuth();
  const query = useAnalyticsQuery();
  const [data, setData] = useState<AnalyticsInfrastructureResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [rateDrafts, setRateDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    const token = session?.access_token;
    if (!token) return;
    let cancelled = false;
    setLoading(true);
    void fetchAnalyticsInfrastructure(token, query.search)
      .then((next) => {
        if (!cancelled) {
          setData(next);
          setError(null);
          setRateDrafts(Object.fromEntries(next.assumptions.map((row) => [row.id, String(row.rate)])));
        }
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Could not load infrastructure.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [session?.access_token, query.search]);

  const kpis = visibleKpis(data?.metrics);

  async function saveRate(id: string) {
    const token = session?.access_token;
    if (!token) return;
    const rate = Number(rateDrafts[id]);
    setSaving(id);
    try {
      await patchAnalyticsCostAssumption(token, { id, rate });
      const next = await fetchAnalyticsInfrastructure(token, query.search);
      setData(next);
      setRateDrafts(Object.fromEntries(next.assumptions.map((row) => [row.id, String(row.rate)])));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update rate.");
    } finally {
      setSaving(null);
    }
  }

  return (
    <section className="admin-section analytics-page">
      <header className="admin-header">
        <div>
          <p className="eyebrow">Analytics</p>
          <h2>Infrastructure</h2>
          <p className="muted">
            {data ? data.range.label : "Selected range"} · original cloud media only
          </p>
        </div>
        <div className="analytics-toolbar">
          <AnalyticsDateRangePicker />
          <AnalyticsGranularityControl />
          <AnalyticsCompareToggle />
        </div>
      </header>
      {error ? (
        <AnalyticsEmptyState title="Could not load infrastructure" body={error} />
      ) : (
        <>
          <p className="muted">
            Storage is original cloud MP4 quota. Bandwidth is not ingested. Costs use editable assumptions, not hardcoded
            provider prices.
          </p>
          <div className="admin-stats analytics-kpis">
            {(kpis.length ? kpis : Array.from({ length: 8 }, (_, index) => ({
              key: `i${index}`,
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
            title="Storage"
            subtitle="Daily added bytes and end-of-day total. Net growth is not fabricated."
            series={[
              { key: "total", label: "Total storage", color: "#7fd0ef", data: { labels: data?.series.labels ?? [], values: data?.series.total ?? [] } },
              { key: "added", label: "Storage added", color: "#f0c27a", data: { labels: data?.series.labels ?? [], values: data?.series.added ?? [] } },
            ]}
          />
          <div className="analytics-breakdown">
            <section>
              <h3>Forecast</h3>
              <p className="muted">{data?.forecast.note}</p>
              <p>30-day added {data?.forecast.storageAdded30 == null ? "Need 3 days" : formatBytes(data.forecast.storageAdded30)}</p>
              <p>90-day added {data?.forecast.storageAdded90 == null ? "Need 3 days" : formatBytes(data.forecast.storageAdded90)}</p>
              <p>Projected 30-day storage cost {money(data?.forecast.cost30Cents)}</p>
              <p>Projected 90-day storage cost {money(data?.forecast.cost90Cents)}</p>
            </section>
            <section>
              <h3>Estimated infra margin</h3>
              <p>Estimated MRR {money(data?.margin.estimatedMrrCents)}</p>
              <p>Estimated variable infra {money(data?.margin.estimatedVariableInfraCents)}</p>
              <p>Estimated gross infrastructure margin {money(data?.margin.estimatedGrossInfrastructureMarginCents)}</p>
              <p className="muted">{data?.margin.note}</p>
            </section>
          </div>
          <div className="analytics-table-wrap">
            <table className="analytics-table">
              <thead>
                <tr>
                  <th>Storage bucket</th>
                  <th>Users</th>
                  <th>% cloud users</th>
                  <th>Bytes</th>
                  <th>% storage</th>
                </tr>
              </thead>
              <tbody>
                {(data?.segments ?? []).map((row) => (
                  <tr key={row.key}>
                    <td>{row.key}</td>
                    <td>{row.users.toLocaleString()}</td>
                    <td>{pct(row.shareOfUsers)}</td>
                    <td>{formatBytes(row.bytes)}</td>
                    <td>{pct(row.shareOfStorage)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="analytics-table-wrap">
            <table className="analytics-table">
              <thead>
                <tr>
                  <th>Plan economics</th>
                  <th>Users</th>
                  <th>Avg storage</th>
                  <th>Avg clips</th>
                  <th>Est. monthly cost</th>
                </tr>
              </thead>
              <tbody>
                {(data?.planEconomics ?? []).map((row) => (
                  <tr key={row.key}>
                    <td>{row.label}</td>
                    <td>{row.users.toLocaleString()}</td>
                    <td>{row.averageStorageBytes == null ? "—" : formatBytes(row.averageStorageBytes)}</td>
                    <td>{row.averageClips == null ? "—" : row.averageClips.toFixed(1)}</td>
                    <td>{money(row.estimatedMonthlyCostCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="analytics-table-wrap">
            <table className="analytics-table">
              <thead>
                <tr>
                  <th>Top consumers</th>
                  <th>Plan</th>
                  <th>Access</th>
                  <th>Storage</th>
                  <th>Ready clips</th>
                  <th>Last active</th>
                </tr>
              </thead>
              <tbody>
                {(data?.topConsumers ?? []).map((row) => (
                  <tr key={row.userId}>
                    <td><code>{row.userId.slice(0, 8)}</code></td>
                    <td>{row.plan}</td>
                    <td>{row.access}</td>
                    <td>{formatBytes(row.storageBytes)}</td>
                    <td>{row.readyClips.toLocaleString()}</td>
                    <td>{row.lastActiveAt ? new Date(row.lastActiveAt).toLocaleDateString() : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="analytics-table-wrap">
            <table className="analytics-table">
              <thead>
                <tr>
                  <th>Cost assumption</th>
                  <th>Unit</th>
                  <th>Rate</th>
                  <th>From</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {(data?.assumptions ?? []).map((row) => (
                  <tr key={row.id}>
                    <td>{row.provider} / {row.metric}</td>
                    <td>{row.unit} · {row.currency}</td>
                    <td>
                      <input
                        type="number"
                        min="0"
                        step="0.001"
                        value={rateDrafts[row.id] ?? String(row.rate)}
                        onChange={(event) => setRateDrafts((current) => ({ ...current, [row.id]: event.target.value }))}
                        aria-label={`${row.provider} ${row.metric} rate`}
                      />
                    </td>
                    <td>{row.effectiveFrom}</td>
                    <td>
                      <button type="button" disabled={saving === row.id} onClick={() => void saveRate(row.id)}>
                        {saving === row.id ? "Saving" : "Save"}
                      </button>
                    </td>
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
          <AnalyticsAvailabilityNotice message="Bandwidth is not instrumented and is hidden, not shown as 0. Forecast is average daily storage added. Deletes are incomplete." />
        </>
      )}
    </section>
  );
}
