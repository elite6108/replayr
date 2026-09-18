import { useEffect, useMemo, useState } from "react";
import { AnalyticsEmptyState } from "../../../components/analytics/AnalyticsEmptyState";
import { fetchAnalyticsLive, type LiveVisitor } from "../../../lib/adminAnalytics";
import { getAnonymousId } from "../../../lib/attribution";
import { useAuth } from "../../../lib/auth";

const BOT_UA = /bot|crawler|spider|curl|wget|python-requests|cf-ray/i;
const SURFACES: Array<LiveVisitor["surface"] | "all"> = ["all", "web", "coming-soon", "desktop", "api", "admin"];

function ago(iso: string, nowMs: number) {
  const delta = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 1000));
  if (delta < 5) return "just now";
  if (delta < 60) return `${delta}s ago`;
  return `${Math.round(delta / 60)}m ago`;
}

function who(row: LiveVisitor) {
  if (!row.user) return "Anonymous";
  return row.user.handle ? `@${row.user.handle}` : row.user.displayName || row.user.email || row.user.id.slice(0, 8);
}

export function AnalyticsLivePage() {
  const { session } = useAuth();
  const selfKey = useMemo(() => getAnonymousId(), []);
  const [data, setData] = useState<{ now: string; count: number; visitors: LiveVisitor[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [surface, setSurface] = useState<(typeof SURFACES)[number]>("all");
  const [signedInOnly, setSignedInOnly] = useState(false);
  const [hideSelf, setHideSelf] = useState(false);
  const [includeBots, setIncludeBots] = useState(false);
  const [tick, setTick] = useState(Date.now());

  useEffect(() => {
    const token = session?.access_token;
    if (!token) return;
    let cancelled = false;
    const load = (quiet = false) => {
      if (!quiet) setLoading(true);
      void fetchAnalyticsLive(token)
        .then((next) => {
          if (!cancelled) {
            setData(next);
            setError(null);
            setTick(Date.now());
          }
        })
        .catch((caught: unknown) => {
          if (!cancelled) setError(caught instanceof Error ? caught.message : "Could not load live visitors.");
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    };
    load();
    const refresh = window.setInterval(() => load(true), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(refresh);
    };
  }, [session?.access_token]);

  const rows = (data?.visitors ?? []).filter((row) => {
    if (surface !== "all" && row.surface !== surface) return false;
    if (signedInOnly && !row.user) return false;
    if (hideSelf && row.visitorKey === selfKey) return false;
    if (!includeBots && row.userAgent && BOT_UA.test(row.userAgent)) return false;
    return true;
  });

  return (
    <section className="admin-section analytics-page">
      <header className="admin-header">
        <div>
          <p className="eyebrow">Analytics</p>
          <h2>Live visitors</h2>
          <p className="muted">Staff-only. Raw IPs for people in the last two minutes. Historical uniques (no IPs) live on Traffic.</p>
        </div>
      </header>
      {error ? (
        <AnalyticsEmptyState title="Could not load live visitors" body={error} />
      ) : (
        <>
          <div className="analytics-kpis">
            <article className={`analytics-kpi${loading && !data ? " is-loading" : ""}`}>
              <div className="analytics-kpi-label">Live now</div>
              <strong>{data ? rows.length : "—"}</strong>
            </article>
          </div>
          <div className="live-filters">
            <label>
              Surface
              <select value={surface} onChange={(event) => setSurface(event.target.value as (typeof SURFACES)[number])}>
                {SURFACES.map((item) => (
                  <option key={item} value={item}>
                    {item === "all" ? "All" : item}
                  </option>
                ))}
              </select>
            </label>
            <label className="live-check">
              <input type="checkbox" checked={signedInOnly} onChange={(event) => setSignedInOnly(event.target.checked)} />
              Signed-in only
            </label>
            <label className="live-check">
              <input type="checkbox" checked={hideSelf} onChange={(event) => setHideSelf(event.target.checked)} />
              Hide this browser
            </label>
            <label className="live-check">
              <input type="checkbox" checked={includeBots} onChange={(event) => setIncludeBots(event.target.checked)} />
              Include bots
            </label>
          </div>
          {rows.length === 0 ? (
            <AnalyticsEmptyState title="Nobody in the live window" body="Heartbeats and API traffic from the last two minutes will show up here." />
          ) : (
            <div className="live-table-wrap">
              <table className="live-table">
                <thead>
                  <tr>
                    <th>Seen</th>
                    <th>Who</th>
                    <th>IP</th>
                    <th>Geo</th>
                    <th>Path</th>
                    <th>Surface</th>
                    <th>Client</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.visitorKey}>
                      <td>{ago(row.lastSeen, tick)}</td>
                      <td>
                        <div>{who(row)}</div>
                        {row.user?.email ? <div className="muted">{row.user.email}</div> : null}
                      </td>
                      <td className="live-mono">{row.ip || "—"}</td>
                      <td>
                        {[row.city, row.country, row.colo].filter(Boolean).join(" · ") || "—"}
                      </td>
                      <td className="live-path">{row.path || "—"}</td>
                      <td>{row.surface}</td>
                      <td className="live-ua" title={row.userAgent || ""}>
                        {row.userAgent ? row.userAgent.slice(0, 72) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
