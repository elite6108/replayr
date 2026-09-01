import { useEffect, useMemo, useState } from "react";
import { AnalyticsAvailabilityNotice } from "../../../components/analytics/AnalyticsAvailabilityNotice";
import { AnalyticsCompareToggle } from "../../../components/analytics/AnalyticsCompareToggle";
import { AnalyticsDateRangePicker } from "../../../components/analytics/AnalyticsDateRangePicker";
import { AnalyticsEmptyState } from "../../../components/analytics/AnalyticsEmptyState";
import { AnalyticsGranularityControl } from "../../../components/analytics/AnalyticsGranularityControl";
import { AnalyticsKpiCard } from "../../../components/analytics/AnalyticsKpiCard";
import { AnalyticsLineChart } from "../../../components/analytics/AnalyticsLineChart";
import { fetchAnalyticsDownloads, type AnalyticsDownloadsResponse } from "../../../lib/adminAnalytics";
import { useAuth } from "../../../lib/auth";
import { useAnalyticsQuery } from "./useAnalyticsQuery";

const TOGGLES = [
  { key: "installer_downloads", label: "Installer Downloads", color: "#7fd0ef" },
  { key: "app_download_clicks", label: "Download Clicks", color: "#c9b6ff" },
  { key: "clip_downloads_authenticated", label: "Authenticated Clips", color: "#8ed9a4" },
  { key: "clip_downloads_public", label: "Public Clips", color: "#f0c27a" },
  { key: "folder_public_downloads", label: "Public Folder", color: "#ff8a8a" },
] as const;

export function AnalyticsDownloadsPage() {
  const { session } = useAuth();
  const query = useAnalyticsQuery();
  const [data, setData] = useState<AnalyticsDownloadsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [visible, setVisible] = useState<string[]>(["installer_downloads", "app_download_clicks"]);

  useEffect(() => {
    const token = session?.access_token;
    if (!token) return;
    let cancelled = false;
    setLoading(true);
    void fetchAnalyticsDownloads(token, query.search)
      .then((next) => {
        if (!cancelled) {
          setData(next);
          setError(null);
        }
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Could not load downloads.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [session?.access_token, query.search]);

  const chartSeries = useMemo(
    () =>
      TOGGLES.filter((item) => visible.includes(item.key)).map((item) => ({
        ...item,
        data: data?.series[item.key] ?? { labels: [], values: [] },
      })),
    [data, visible],
  );

  return (
    <section className="admin-section analytics-page">
      <header className="admin-header">
        <div>
          <p className="eyebrow">Analytics</p>
          <h2>Downloads</h2>
          <p className="muted">{data ? data.range.label : "Selected range"} — not all-time unless All Time is selected.</p>
        </div>
        <div className="analytics-toolbar">
          <AnalyticsDateRangePicker />
          <AnalyticsGranularityControl />
          <AnalyticsCompareToggle />
        </div>
      </header>
      <AnalyticsAvailabilityNotice message={data?.tracking.notice} />
      {error ? (
        <AnalyticsEmptyState title="Could not load downloads" body={error} />
      ) : (
        <>
          <div className="admin-stats analytics-kpis">
            {(data?.metrics ?? []).map((kpi) => (
              <AnalyticsKpiCard key={kpi.key} kpi={kpi} loading={loading && !data} />
            ))}
          </div>
          {data?.conversion ? (
            <p className="muted">
              Click → installer: {data.conversion.clicks ?? "—"} clicks, {data.conversion.installers ?? "—"} installers
              {data.conversion.rate != null ? ` (${Math.round(data.conversion.rate * 1000) / 10}%)` : data.conversion.label ? ` (${data.conversion.label})` : ""}.
              {` ${data.conversion.note}`}
            </p>
          ) : null}
          <div className="analytics-series-toggles">
            {TOGGLES.map((item) => (
              <label key={item.key}>
                <input
                  type="checkbox"
                  checked={visible.includes(item.key)}
                  onChange={() =>
                    setVisible((current) =>
                      current.includes(item.key) ? current.filter((key) => key !== item.key) : [...current, item.key],
                    )
                  }
                />
                {item.label}
              </label>
            ))}
          </div>
          <AnalyticsLineChart title="Downloads Over Time" subtitle={data?.range.label} series={chartSeries} />
          <div className="analytics-breakdown">
            <section>
              <h3>App</h3>
              <p>Installer Downloads {data?.breakdown.app.installer_downloads?.toLocaleString() ?? "—"}</p>
              <p>Download Clicks {data?.breakdown.app.app_download_clicks?.toLocaleString() ?? "—"}</p>
            </section>
            <section>
              <h3>Media</h3>
              <p>Authenticated Clips {data?.breakdown.media.clip_downloads_authenticated?.toLocaleString() ?? "—"}</p>
              <p>Public Clips {data?.breakdown.media.clip_downloads_public?.toLocaleString() ?? "—"}</p>
              <p>Public Folder {data?.breakdown.media.folder_public_downloads?.toLocaleString() ?? "—"}</p>
            </section>
          </div>
          <p className="muted analytics-freshness">
            {data?.lastUpdated
              ? `Last updated ${new Date(data.lastUpdated).toLocaleString()} · hourly rollup`
              : "Last updated — · hourly rollup"}
          </p>
        </>
      )}
    </section>
  );
}
