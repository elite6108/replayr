import { useEffect, useState } from "react";
import {
  fetchAdminPlans,
  fetchAdminUsers,
  updateAdminUser,
  type AdminPlan,
  type AdminUserRow,
} from "../../lib/admin";
import { useAuth } from "../../lib/auth";
import { formatBytes, formatClipDate, planLabel } from "../../lib/format";

export function AdminUsersPage() {
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const [query, setQuery] = useState("");
  const [plan, setPlan] = useState("");
  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [plans, setPlans] = useState<AdminPlan[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load(nextQuery = query, nextPlan = plan) {
    if (!token) return;
    setError(null);
    try {
      const [list, planList] = await Promise.all([
        fetchAdminUsers(token, { q: nextQuery || undefined, plan: nextPlan || undefined }),
        fetchAdminPlans(token),
      ]);
      setUsers(list.items);
      setTotal(list.total);
      setPlans(planList.plans);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load users.");
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  async function changePlan(user: AdminUserRow, planSlug: string) {
    if (!token || planSlug === user.planSlug) return;
    if (!window.confirm(`Move ${user.email || user.username || "this account"} to ${planLabel(planSlug)}?`)) return;
    setBusyId(user.id);
    try {
      await updateAdminUser(token, user.id, { planSlug });
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update plan.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="admin-section">
      <header className="admin-header">
        <div>
          <p className="eyebrow">Accounts</p>
          <h2>Users</h2>
          <p className="muted">{total ? `${total} matching` : "Search email, username, or display name."}</p>
        </div>
        <form
          className="admin-filters"
          onSubmit={(event) => {
            event.preventDefault();
            void load();
          }}
        >
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search email or username"
            aria-label="Search users"
          />
          <select value={plan} onChange={(event) => setPlan(event.target.value)} aria-label="Plan">
            <option value="">All plans</option>
            {plans.map((item) => (
              <option key={item.slug} value={item.slug}>
                {planLabel(item.slug)}
              </option>
            ))}
          </select>
          <button className="btn primary" type="submit">
            Search
          </button>
        </form>
      </header>
      {error ? <p className="error">{error}</p> : null}
      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Account</th>
              <th>Plan</th>
              <th>Storage</th>
              <th>Clips</th>
              <th>Last sign-in</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => {
              const used = user.storageUsedBytes;
              const limit = user.storageLimitBytes;
              const percent = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
              return (
                <tr key={user.id}>
                  <td>
                    <strong>{user.displayName || user.username || "No name"}</strong>
                    <span className="muted">
                      {user.email || "—"}
                      {user.username ? ` · @${user.username}` : ""}
                      {user.role === "admin" ? " · admin" : ""}
                      {user.isVerified ? " · verified" : ""}
                    </span>
                  </td>
                  <td>
                    <select
                      value={user.planSlug}
                      disabled={busyId === user.id}
                      onChange={(event) => void changePlan(user, event.target.value)}
                      aria-label={`Plan for ${user.email || user.username || "user"}`}
                    >
                      {(plans.length ? plans : [{ slug: user.planSlug, storageLimitBytes: user.storageLimitBytes }]).map(
                        (item) => (
                          <option key={item.slug} value={item.slug}>
                            {planLabel(item.slug)}
                          </option>
                        ),
                      )}
                    </select>
                  </td>
                  <td>
                    <div className="admin-meter" aria-label={`${percent}% used`}>
                      <span style={{ width: `${percent}%` }} />
                    </div>
                    <span className="muted">
                      {formatBytes(used)} / {formatBytes(limit)}
                    </span>
                  </td>
                  <td>{user.clipCount}</td>
                  <td>{user.lastSignInAt ? formatClipDate(user.lastSignInAt) : "Never"}</td>
                  <td>{user.createdAt ? formatClipDate(user.createdAt) : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {users.length === 0 ? <p className="muted admin-empty">No accounts match.</p> : null}
      </div>
    </section>
  );
}
