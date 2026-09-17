import { useEffect, useMemo, useState } from "react";
import {
  fetchAdminClips,
  fetchAdminOverview,
  fetchAdminUsers,
  fetchWorkerHealth,
  type AdminClipRow,
  type AdminOverview,
  type AdminUserRow,
} from "../../lib/admin";
import { fetchAnalyticsGrowth, fetchAnalyticsOverview, type AnalyticsSeries } from "../../lib/adminAnalytics";
import { useAuth } from "../../lib/auth";
import { formatBytes } from "../../lib/format";
import { useStaffPermissions } from "../../lib/staff";
import { ActivityChart } from "./components/ActivityChart";
import { AdminHeader } from "./components/AdminHeader";
import { MetricCard } from "./components/MetricCard";
import { RecentClipsCard } from "./components/RecentClipsCard";
import { RecentUsersCard } from "./components/RecentUsersCard";
import { StorageUsageCard } from "./components/StorageUsageCard";
import { SystemHealthCard, type HealthRow } from "./components/SystemHealthCard";
import {
  IconAccounts,
  IconActive,
  IconAnnouncements,
  IconBilling,
  IconClips,
  IconCloud,
  IconCreators,
  IconErrors,
  IconPremium,
} from "./components/adminIcons";

const cards: Array<{
  key: keyof AdminOverview;
  label: string;
  to: string;
  icon: typeof IconAccounts;
  format?: (value: number) => string;
}> = [
  { key: "users", label: "Accounts", to: "/admin/users", icon: IconAccounts },
  { key: "active7d", label: "Active in 7 days", to: "/admin/users", icon: IconActive },
  { key: "readyClips", label: "Ready clips", to: "/admin/clips", icon: IconClips },
  { key: "clipsToday", label: "Clips today", to: "/admin/clips", icon: IconClips },
  { key: "storageUsedBytes", label: "Cloud storage used", to: "/admin/storage", icon: IconCloud, format: formatBytes },
  { key: "pendingCreatorApps", label: "Pending creators", to: "/admin/creators", icon: IconCreators },
  { key: "premiumCount", label: "Premium accounts", to: "/admin/billing", icon: IconPremium },
  { key: "pastDueCount", label: "Past due", to: "/admin/billing", icon: IconBilling },
  { key: "openErrors", label: "Open errors", to: "/admin/errors", icon: IconErrors },
  { key: "errors24h", label: "Error groups / 24h", to: "/admin/errors", icon: IconAnnouncements },
];

const unmonitored: HealthRow[] = [
  { label: "Database", status: "unmonitored" },
  { label: "Media Processing", status: "unmonitored" },
  { label: "Realtime", status: "unmonitored" },
  { label: "Web App", status: "unmonitored" },
  { label: "Desktop App", status: "unmonitored" },
];

export function AdminOverviewPage() {
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const { can } = useStaffPermissions();
  const canAnalytics = can("analytics.view");
  const [data, setData] = useState<AdminOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [range, setRange] = useState("last_7");
  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [usersError, setUsersError] = useState<string | null>(null);
  const [usersLoading, setUsersLoading] = useState(true);
  const [clips, setClips] = useState<AdminClipRow[]>([]);
  const [clipsError, setClipsError] = useState<string | null>(null);
  const [clipsLoading, setClipsLoading] = useState(true);
  const [health, setHealth] = useState<HealthRow[]>([]);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [healthLoading, setHealthLoading] = useState(true);
  const [active, setActive] = useState<AnalyticsSeries | null>(null);
  const [signups, setSignups] = useState<AnalyticsSeries | null>(null);
  const [clipSeries, setClipSeries] = useState<AnalyticsSeries | null>(null);
  const [chartError, setChartError] = useState<string | null>(null);
  const [chartLoading, setChartLoading] = useState(false);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    void fetchAdminOverview(token)
      .then((next) => {
        if (cancelled) return;
        setData(next);
        setUpdatedAt(new Date());
        setError(null);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Could not load overview.");
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    setUsersLoading(true);
    void fetchAdminUsers(token)
      .then((body) => {
        if (cancelled) return;
        setUsers(
          [...body.items].sort((a, b) => Date.parse(b.createdAt || "") - Date.parse(a.createdAt || "")).slice(0, 5),
        );
        setUsersError(null);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setUsersError(caught instanceof Error ? caught.message : "Could not load accounts.");
      })
      .finally(() => {
        if (!cancelled) setUsersLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    setClipsLoading(true);
    void fetchAdminClips(token)
      .then((body) => {
        if (cancelled) return;
        setClips(body.items.slice(0, 5));
        setClipsError(null);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setClipsError(caught instanceof Error ? caught.message : "Could not load clips.");
      })
      .finally(() => {
        if (!cancelled) setClipsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    let cancelled = false;
    setHealthLoading(true);
    void fetchWorkerHealth()
      .then((body) => {
        if (cancelled) return;
        setHealth([
          { label: "API", status: body.ok ? "operational" : "unknown" },
          { label: "Storage (R2)", status: body.storage ? "operational" : "unknown" },
          ...unmonitored,
        ]);
        setHealthError(null);
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setHealth([{ label: "API", status: "unknown" }, { label: "Storage (R2)", status: "unknown" }, ...unmonitored]);
        setHealthError(caught instanceof Error ? caught.message : "Could not load health.");
      })
      .finally(() => {
        if (!cancelled) setHealthLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!token || !canAnalytics) {
      setActive(null);
      setSignups(null);
      setClipSeries(null);
      setChartLoading(false);
      return;
    }
    let cancelled = false;
    setChartLoading(true);
    const search = `?range=${encodeURIComponent(range)}&compare=0`;
    void Promise.all([fetchAnalyticsGrowth(token, search), fetchAnalyticsOverview(token, search)])
      .then(([growth, overview]) => {
        if (cancelled) return;
        setActive({ labels: growth.series.labels, values: growth.series.dau });
        setSignups(overview.series.new_users ?? { labels: [], values: [] });
        setClipSeries(overview.series.ready_cloud_clips_created ?? { labels: [], values: [] });
        setChartError(null);
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setActive(null);
          setSignups(null);
          setClipSeries(null);
          setChartError(caught instanceof Error ? caught.message : "Could not load activity.");
        }
      })
      .finally(() => {
        if (!cancelled) setChartLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token, range, canAnalytics]);

  const caption = useMemo(() => {
    if (!data) return null;
    return `Signed in today: ${data.active1d.toLocaleString()} · last 30 days: ${data.active30d.toLocaleString()}`;
  }, [data]);

  return (
    <section className="admin-dash">
      <AdminHeader updatedAt={updatedAt} range={range} onRangeChange={setRange} />
      {error ? <p className="error">{error}</p> : null}
      <div className="admin-metrics">
        {cards.map((card) => (
          <MetricCard
            key={card.key}
            to={card.to}
            label={card.label}
            icon={card.icon}
            value={
              data
                ? card.format
                  ? card.format(Number(data[card.key] ?? 0))
                  : Number(data[card.key] ?? 0).toLocaleString()
                : "—"
            }
          />
        ))}
      </div>
      {caption ? <p className="muted admin-dash-caption">{caption}</p> : null}
      <div className="admin-mid">
        <ActivityChart loading={chartLoading} error={chartError} active={active} signups={signups} clips={clipSeries} />
        <StorageUsageCard bytes={data?.storageUsedBytes ?? null} />
      </div>
      <div className="admin-lower">
        <RecentUsersCard users={users} loading={usersLoading} error={usersError} />
        <RecentClipsCard clips={clips} loading={clipsLoading} error={clipsError} />
        <SystemHealthCard rows={health} loading={healthLoading} error={healthError} />
      </div>
    </section>
  );
}
