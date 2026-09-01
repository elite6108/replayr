import { useEffect, useState } from "react";
import { AnalyticsDateRangePicker } from "../../../components/analytics/AnalyticsDateRangePicker";
import { AnalyticsEmptyState } from "../../../components/analytics/AnalyticsEmptyState";
import { AnalyticsKpiCard } from "../../../components/analytics/AnalyticsKpiCard";
import { fetchAnalyticsFolders, type AnalyticsFoldersResponse } from "../../../lib/adminAnalytics";
import { useAuth } from "../../../lib/auth";
import { useAnalyticsQuery } from "./useAnalyticsQuery";

function pct(value: number | null) {
  return value == null ? "—" : `${Math.round(value * 1000) / 10}%`;
}

export function AnalyticsFoldersPage() {
  const { session } = useAuth();
  const query = useAnalyticsQuery();
  const [data, setData] = useState<AnalyticsFoldersResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = session?.access_token;
    if (!token) return;
    let cancelled = false;
    setLoading(true);
    void fetchAnalyticsFolders(token, query.search)
      .then((next) => {
        if (!cancelled) {
          setData(next);
          setError(null);
        }
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Could not load folders.");
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
          <h2>Folders</h2>
          <p className="muted">{data ? data.range.label : "Selected range"}</p>
        </div>
        <div className="analytics-toolbar">
          <AnalyticsDateRangePicker />
        </div>
      </header>
      {error ? (
        <AnalyticsEmptyState title="Could not load folders" body={error} />
      ) : (
        <>
          <div className="admin-stats analytics-kpis">
            {(data?.metrics ?? []).map((kpi) => (
              <AnalyticsKpiCard key={kpi.key} kpi={kpi} loading={loading && !data} />
            ))}
          </div>
          <div className="analytics-breakdown">
            <section>
              <h3>People</h3>
              <p>Owners · {data?.snapshot.uniqueOwners ?? 0}</p>
              <p>Collaborators · {data?.snapshot.uniqueCollaborators ?? 0}</p>
              <p>Folder users · {data?.snapshot.uniqueFolderUsers ?? 0}</p>
            </section>
            <section>
              <h3>Engagement</h3>
              <p>{data?.engagement.note}</p>
              <p>Folder users active · {pct(data?.engagement.folderUsers ?? null)}</p>
              <p>Collaborators active · {pct(data?.engagement.collaborators ?? null)}</p>
              <p>Everyone else · {pct(data?.engagement.others ?? null)}</p>
              <p>Folder users paid · {pct(data?.engagement.folderPaidShare ?? null)}</p>
              <p>Collaborators paid · {pct(data?.engagement.collaboratorPaidShare ?? null)}</p>
            </section>
          </div>
        </>
      )}
    </section>
  );
}
