import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { clipShareUrl, publicApiUrl, publicAppUrl, publicSiteUrl } from "../branding";
import { PageHeader } from "../components/common/PageHeader";
import {
  deleteAdminClip,
  fetchAdminClips,
  fetchAdminCreators,
  fetchAdminOverview,
  fetchAdminPlans,
  fetchAdminStorage,
  fetchAdminUsers,
  reviewCreatorApplication,
  updateAdminUser,
  type AdminClipRow,
  type AdminCreatorRow,
  type AdminOverview,
  type AdminPlan,
  type AdminStorageRow,
  type AdminUserRow,
} from "../services/admin";
import { useAuthStore } from "../stores/authStore";
import { isAdminSession } from "../utils/admin";
import { formatBytes, formatClipDate, formatDuration, planLabel } from "../utils/format";

type Tab = "overview" | "users" | "clips" | "storage" | "creators";

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
  const [query, setQuery] = useState("");
  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [plans, setPlans] = useState<AdminPlan[]>([]);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <section className="stack">
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
              <th>Last sign-in</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id}>
                <td>
                  {user.email || user.username || user.id}
                  {user.username ? <span className="muted"> @{user.username}</span> : null}
                </td>
                <td>
                  <select
                    value={user.planSlug}
                    onChange={(event) => {
                      const planSlug = event.target.value;
                      if (!window.confirm(`Move this account to ${planLabel(planSlug)}?`)) return;
                      void updateAdminUser(token, user.id, { planSlug }).then(() => load());
                    }}
                  >
                    {plans.map((plan) => (
                      <option key={plan.slug} value={plan.slug}>
                        {planLabel(plan.slug)}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  {formatBytes(user.storageUsedBytes)} / {formatBytes(user.storageLimitBytes)}
                </td>
                <td>{user.clipCount}</td>
                <td>{user.lastSignInAt ? formatClipDate(user.lastSignInAt) : "Never"}</td>
              </tr>
            ))}
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
