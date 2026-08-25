import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { clipShareUrl, publicApiUrl, publicAppUrl, publicSiteUrl } from "../branding";
import { PageHeader } from "../components/common/PageHeader";
import {
  adminBillingAction,
  deleteAdminClip,
  fetchAdminClips,
  fetchAdminCreators,
  fetchAdminErrors,
  fetchAdminOverview,
  fetchAdminPlans,
  fetchAdminStorage,
  fetchAdminUsers,
  resolveAdminError,
  reviewCreatorApplication,
  updateAdminUser,
  type AdminClipRow,
  type AdminCreatorRow,
  type AdminErrorRow,
  type AdminOverview,
  type AdminPlan,
  type AdminStorageRow,
  type AdminUserRow,
} from "../services/admin";
import { useAuthStore } from "../stores/authStore";
import { useBillingStore } from "../stores/billingStore";
import { isAdminSession } from "../utils/admin";
import { formatBytes, formatClipDate, formatDuration, planLabel } from "../utils/format";

type Tab = "overview" | "users" | "clips" | "storage" | "creators" | "errors" | "billing";

function consoleUrl() {
  try {
    const host = new URL(publicAppUrl()).hostname;
    if (host === "127.0.0.1" || host === "localhost") return "http://localhost:5174/admin";
  } catch {
    /* keep site console */
  }
  return `${publicSiteUrl()}/admin`;
}

export function AdminPage() {
  const session = useAuthStore((state) => state.session);
  const token = session?.access_token ?? "";
  const [tab, setTab] = useState<Tab>("overview");

  if (!isAdminSession(session)) return <Navigate to="/" replace />;

  return (
    <>
      <PageHeader title="Admin" subtitle="Operator tools. The full console lives on the website.">
        <button
          className="btn primary"
          type="button"
          onClick={() => {
            void import("@tauri-apps/plugin-opener").then(({ openUrl }) => openUrl(consoleUrl()));
          }}
        >
          Open web console
        </button>
      </PageHeader>
      <div className="tabs admin-tabs" role="tablist">
        {(
          [
            ["overview", "Overview"],
            ["users", "Users"],
            ["clips", "Clips"],
            ["storage", "Storage"],
            ["creators", "Creators"],
            ["errors", "Errors"],
            ["billing", "Billing"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            className={tab === id ? "active" : ""}
            aria-selected={tab === id}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "overview" ? <OverviewPane token={token} /> : null}
      {tab === "users" ? <UsersPane token={token} /> : null}
      {tab === "clips" ? <ClipsPane token={token} /> : null}
      {tab === "storage" ? <StoragePane token={token} /> : null}
      {tab === "creators" ? <CreatorsPane token={token} /> : null}
      {tab === "errors" ? <ErrorsPane token={token} /> : null}
      {tab === "billing" ? (
        <section className="panel stack">
          <p className="muted">Grant plans, comps, and Stripe events live in the website console.</p>
          <button
            className="btn primary"
            type="button"
            onClick={() => {
              void import("@tauri-apps/plugin-opener").then(({ openUrl }) => openUrl(`${consoleUrl()}/billing`));
            }}
          >
            Open billing console
          </button>
        </section>
      ) : null}
    </>
  );
}

function OverviewPane({ token }: { token: string }) {
  const [data, setData] = useState<AdminOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  function load() {
    if (!token) return;
    setError(null);
    void fetchAdminOverview(token)
      .then(setData)
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Could not load overview."));
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);
  return (
    <section className="stack">
      {error ? <AdminError message={error} onRetry={load} /> : null}
      <div className="grid cols-3 admin-stats">
        <Stat label="Accounts" value={data?.users} />
        <Stat label="Active 7d" value={data?.active7d} />
        <Stat label="Ready clips" value={data?.readyClips} />
        <Stat label="Clips today" value={data?.clipsToday} />
        <Stat label="Cloud used" value={data ? formatBytes(data.storageUsedBytes) : undefined} />
        <Stat label="Pending creators" value={data?.pendingCreatorApps} />
        <Stat label="Premium" value={data?.premiumCount} />
        <Stat label="Past due" value={data?.pastDueCount} />
        <Stat label="Open errors" value={data?.openErrors} />
        <Stat label="Errors / 24h" value={data?.errors24h} />
      </div>
    </section>
  );
}

function AdminError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="stack">
      <p className="error">{message}</p>
      <p className="muted">Desktop calls {publicApiUrl()}</p>
      <button className="btn" type="button" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}

function Stat({ label, value }: { label: string; value?: number | string }) {
  return (
    <article className="panel">
      <p className="muted">{label}</p>
      <strong>{value ?? "—"}</strong>
    </article>
  );
}

function UsersPane({ token }: { token: string }) {
  const selfId = useAuthStore((state) => state.user?.id);
  const refreshBilling = useBillingStore((state) => state.load);
  const [query, setQuery] = useState("");
  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [plans, setPlans] = useState<AdminPlan[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const slugs = plans.length ? plans.map((plan) => plan.slug) : ["free", "pro", "pro_plus"];

  async function load(next = query) {
    try {
      const [list, planList] = await Promise.all([
        fetchAdminUsers(token, { q: next || undefined }),
        fetchAdminPlans(token),
      ]);
      setUsers(list.users);
      setPlans(planList.plans);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load users.");
    }
  }

  useEffect(() => {
    if (token) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  async function afterChange(userId: string) {
    await load();
    if (userId === selfId) {
      await refreshBilling(token);
      await useAuthStore.getState().refreshProfile();
    }
  }

  async function setFree(user: AdminUserRow) {
    const who = user.email || user.username || "this account";
    if (!window.confirm(`Put ${who} on Free now? This removes comps and cancels any Stripe subscription.`)) return;
    setBusyId(user.id);
    try {
      await adminBillingAction(token, user.id, { action: "revoke" });
      await afterChange(user.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not move that account to Free.");
    } finally {
      setBusyId(null);
    }
  }

  async function givePremium(user: AdminUserRow, slug: "pro" | "pro_plus" = "pro") {
    const who = user.email || user.username || "this account";
    if (!window.confirm(`Give ${who} ${planLabel(slug)}?`)) return;
    setBusyId(user.id);
    try {
      await adminBillingAction(token, user.id, { action: "grant", planSlug: slug, reason: "Admin grant" });
      await afterChange(user.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not grant Premium.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="stack">
      <p className="muted">Search your email, then Give Premium or Set to Free. That also works on your own account.</p>
      <form
        className="row"
        onSubmit={(event) => {
          event.preventDefault();
          void load();
        }}
      >
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search email or username" />
        <button className="btn" type="submit">
          Search
        </button>
      </form>
      {error ? <AdminError message={error} onRetry={() => void load()} /> : null}
      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Account</th>
              <th>Plan</th>
              <th>Storage</th>
              <th>Clips</th>
              <th>Access</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => {
              const busy = busyId === user.id;
              const you = user.id === selfId;
              return (
                <tr key={user.id}>
                  <td>
                    {user.email || user.username || user.id}
                    {you ? <span className="muted"> · you</span> : null}
                    {user.username ? <span className="muted"> @{user.username}</span> : null}
                  </td>
                  <td>
                    {planLabel(user.planSlug)}
                    {user.complimentary ? <span className="muted"> · comp</span> : null}
                    {user.stripeStatus ? <span className="muted"> · {user.stripeStatus}</span> : null}
                  </td>
                  <td>
                    {formatBytes(user.storageUsedBytes)} / {formatBytes(user.storageLimitBytes)}
                  </td>
                  <td>{user.clipCount}</td>
                  <td className="row">
                    {user.planSlug === "pro" || user.planSlug === "pro_plus" ? (
                      <button className="btn" type="button" disabled={busy} onClick={() => void setFree(user)}>
                        Set to Free
                      </button>
                    ) : (
                      <button className="btn primary" type="button" disabled={busy} onClick={() => void givePremium(user)}>
                        Give Premium
                      </button>
                    )}
                    {user.planSlug !== "pro_plus" ? (
                      <button className="btn" type="button" disabled={busy} onClick={() => void givePremium(user, "pro_plus")}>
                        Give Pro+
                      </button>
                    ) : null}
                    <select
                      value={user.planSlug}
                      disabled={busy}
                      aria-label={`Plan for ${user.email || user.username || "user"}`}
                      onChange={(event) => {
                        const planSlug = event.target.value;
                        if (planSlug === user.planSlug) return;
                        if (!window.confirm(`Move this account to ${planLabel(planSlug)}?`)) return;
                        setBusyId(user.id);
                        void updateAdminUser(token, user.id, { planSlug })
                          .then(() => afterChange(user.id))
                          .catch((caught: unknown) => {
                            setError(caught instanceof Error ? caught.message : "Could not update plan.");
                          })
                          .finally(() => setBusyId(null));
                      }}
                    >
                      {slugs.map((plan) => (
                        <option key={plan} value={plan}>
                          {planLabel(plan)}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ClipsPane({ token }: { token: string }) {
  const [query, setQuery] = useState("");
  const [clips, setClips] = useState<AdminClipRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function load(next = query) {
    try {
      const list = await fetchAdminClips(token, { q: next || undefined });
      setClips(list.clips);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load clips.");
    }
  }

  useEffect(() => {
    if (token) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  return (
    <section className="stack">
      <form
        className="row"
        onSubmit={(event) => {
          event.preventDefault();
          void load();
        }}
      >
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Title, slug, or owner" />
        <button className="btn" type="submit">
          Filter
        </button>
      </form>
      {error ? <p className="error">{error}</p> : null}
      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Clip</th>
              <th>Owner</th>
              <th>Status</th>
              <th>Created</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {clips.map((clip) => (
              <tr key={clip.id}>
                <td>
                  {clip.title || clip.slug}
                  <span className="muted">
                    {" "}
                    {clip.gameName || "No game"} · {formatDuration(clip.durationMs)}
                  </span>
                </td>
                <td>{clip.ownerEmail || clip.ownerUsername || "—"}</td>
                <td>{clip.status}</td>
                <td>{formatClipDate(clip.createdAt)}</td>
                <td className="row">
                  <button
                    className="btn ghost"
                    type="button"
                    onClick={() => void navigator.clipboard.writeText(clipShareUrl(clip.slug))}
                  >
                    Copy link
                  </button>
                  {clip.status !== "deleted" ? (
                    <button
                      className="btn danger"
                      type="button"
                      onClick={() => {
                        if (!window.confirm(`Soft-delete ${clip.title || clip.slug}?`)) return;
                        void deleteAdminClip(token, clip.id).then(() => load());
                      }}
                    >
                      Soft-delete
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function StoragePane({ token }: { token: string }) {
  const [accounts, setAccounts] = useState<AdminStorageRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!token) return;
    void fetchAdminStorage(token)
      .then((next) => setAccounts(next.accounts))
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Could not load storage."));
  }, [token]);
  return (
    <section className="stack">
      {error ? <p className="error">{error}</p> : null}
      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Account</th>
              <th>Plan</th>
              <th>Used</th>
              <th>Clips</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((row) => (
              <tr key={row.userId}>
                <td>{row.email || row.username || row.userId}</td>
                <td>{planLabel(row.planSlug)}</td>
                <td>
                  {formatBytes(row.storageUsedBytes)} / {formatBytes(row.storageLimitBytes)} ({row.percent}%)
                </td>
                <td>{row.clipCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function CreatorsPane({ token }: { token: string }) {
  const [applications, setApplications] = useState<AdminCreatorRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const next = await fetchAdminCreators(token, "pending");
      setApplications(next.applications);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load applications.");
    }
  }

  useEffect(() => {
    if (token) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  return (
    <section className="stack">
      {error ? <p className="error">{error}</p> : null}
      {applications.length === 0 ? <p className="muted">No pending creator applications.</p> : null}
      {applications.map((row) => (
        <article key={row.id} className="panel stack">
          <strong>{row.displayName}</strong>
          <p className="muted">
            {row.email} {row.username ? `· @${row.username}` : ""} · {formatClipDate(row.createdAt)}
          </p>
          <a href={row.channelUrl}>{row.channelUrl}</a>
          {row.game ? <p>{row.game}</p> : null}
          {row.note ? <p>{row.note}</p> : null}
          <div className="row">
            <button
              className="btn primary"
              type="button"
              onClick={() => void reviewCreatorApplication(token, row.id, "approved").then(() => load())}
            >
              Approve
            </button>
            <button
              className="btn danger"
              type="button"
              onClick={() => void reviewCreatorApplication(token, row.id, "rejected").then(() => load())}
            >
              Reject
            </button>
          </div>
        </article>
      ))}
    </section>
  );
}

function ErrorsPane({ token }: { token: string }) {
  const [errors, setErrors] = useState<AdminErrorRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  async function load() {
    try {
      const next = await fetchAdminErrors(token);
      setErrors(next.errors);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load error logs.");
    }
  }

  useEffect(() => {
    if (token) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  return (
    <section className="stack">
      {error ? <p className="error">{error}</p> : null}
      {errors.length === 0 ? <p className="muted">No open error groups.</p> : null}
      {errors.map((row) => (
        <article key={row.fingerprint} className="panel stack">
          <strong>{row.message}</strong>
          <p className="muted">
            {row.surface} · {row.level} · {row.count}× · {formatClipDate(row.lastSeenAt)}
            {row.path ? ` · ${row.path}` : ""}
          </p>
          <div className="row">
            {row.stack ? (
              <button
                className="btn"
                type="button"
                onClick={() => setOpenId((current) => (current === row.fingerprint ? null : row.fingerprint))}
              >
                {openId === row.fingerprint ? "Hide stack" : "Stack"}
              </button>
            ) : null}
            <button
              className="btn"
              type="button"
              onClick={() => void resolveAdminError(token, row.fingerprint).then(() => load())}
            >
              Resolve
            </button>
          </div>
          {openId === row.fingerprint && row.stack ? <pre className="admin-stack">{row.stack}</pre> : null}
        </article>
      ))}
    </section>
  );
}
