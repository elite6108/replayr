import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchAdminOverview, type AdminOverview } from "../../lib/admin";
import { useAuth } from "../../lib/auth";
import { formatBytes } from "../../lib/format";

const cards: { key: keyof AdminOverview; label: string; to: string; format?: (value: number) => string }[] = [
  { key: "users", label: "Accounts", to: "/admin/users" },
  { key: "active7d", label: "Active in 7 days", to: "/admin/users" },
  { key: "readyClips", label: "Ready clips", to: "/admin/clips" },
  { key: "clipsToday", label: "Clips today", to: "/admin/clips" },
  { key: "storageUsedBytes", label: "Cloud storage used", to: "/admin/storage", format: formatBytes },
  { key: "pendingCreatorApps", label: "Pending creators", to: "/admin/creators" },
  { key: "premiumCount", label: "Premium accounts", to: "/admin/billing" },
  { key: "pastDueCount", label: "Past due", to: "/admin/billing" },
  { key: "openErrors", label: "Open errors", to: "/admin/errors" },
  { key: "errors24h", label: "Error groups / 24h", to: "/admin/errors" },
];

export function AdminOverviewPage() {
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const [data, setData] = useState<AdminOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    void fetchAdminOverview(token)
      .then((next) => {
        if (!cancelled) setData(next);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Could not load overview.");
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <section className="admin-section">
      <header className="admin-header">
        <div>
          <p className="eyebrow">Live</p>
          <h2>What is on Replayr right now</h2>
          <p className="muted">Counts come from Auth and Postgres. Active users use last sign-in, not invented DAU.</p>
        </div>
      </header>
      {error ? <p className="error">{error}</p> : null}
      <div className="admin-stats">
        {cards.map((card) => (
          <Link key={card.key} className="admin-stat" to={card.to}>
            <span>{card.label}</span>
            <strong>
              {data
                ? card.format
                  ? card.format(Number(data[card.key] ?? 0))
                  : Number(data[card.key] ?? 0).toLocaleString()
                : "—"}
            </strong>
          </Link>
        ))}
      </div>
      {data ? (
        <p className="muted">
          Signed in today: {data.active1d.toLocaleString()} · last 30 days: {data.active30d.toLocaleString()}
        </p>
      ) : (
        <p className="muted">Loading live counts…</p>
      )}
    </section>
  );
}
