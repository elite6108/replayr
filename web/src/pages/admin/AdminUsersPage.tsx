import { useEffect, useState } from "react";
import {
  adminBillingAction,
  fetchAdminPlans,
  fetchAdminUsers,
  updateAdminUser,
  type AdminPlan,
  type AdminUserRow,
} from "../../lib/admin";
import { useAuth } from "../../lib/auth";
import { formatBytes, formatClipDate, planLabel } from "../../lib/format";

const PLAN_OPTIONS = ["free", "pro", "pro_plus"] as const;

function isPaidPlan(slug: string) {
  return slug === "pro" || slug === "pro_plus";
}

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

  async function setFree(user: AdminUserRow) {
    if (!token) return;
    const who = user.email || user.username || "this account";
    if (!window.confirm(`Put ${who} on Free now? This removes comps and cancels any Stripe subscription.`)) return;
    setBusyId(user.id);
    try {
      await adminBillingAction(token, user.id, { action: "revoke" });
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not move that account to Free.");
    } finally {
      setBusyId(null);
    }
  }

  async function givePremium(user: AdminUserRow, slug: "pro" | "pro_plus" = "pro") {
    if (!token) return;
    const who = user.email || user.username || "this account";
    if (!window.confirm(`Give ${who} ${planLabel(slug)}?`)) return;
    setBusyId(user.id);
    try {
      await adminBillingAction(token, user.id, { action: "grant", planSlug: slug, reason: "Admin grant" });
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not grant Premium.");
    } finally {
      setBusyId(null);
    }
  }

  async function runStripe(user: AdminUserRow, action: string) {
    if (!token || !action) return;
    if (action === "stripe") {
      if (!user.stripeCustomerId) return;
      window.open(`https://dashboard.stripe.com/customers/${user.stripeCustomerId}`, "_blank", "noreferrer");
      return;
    }
    const who = user.email || user.username || "this account";
    if (action === "cancel" && !window.confirm(`Cancel ${who} at period end in Stripe?`)) return;
    if (action === "extend") {
      const daysRaw = window.prompt("Extend trial by how many days?", "7");
      if (daysRaw == null) return;
      setBusyId(user.id);
      try {
        await adminBillingAction(token, user.id, { action: "extend_trial", days: Math.max(1, Number(daysRaw) || 7) });
        await load();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Could not extend the trial.");
      } finally {
        setBusyId(null);
      }
      return;
    }
    if (action !== "cancel") return;
    setBusyId(user.id);
    try {
      await adminBillingAction(token, user.id, { action: "cancel" });
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update Stripe.");
    } finally {
      setBusyId(null);
    }
  }

  const slugs = plans.length ? plans.map((item) => item.slug) : [...PLAN_OPTIONS];

  return (
    <section className="admin-section">
      <header className="admin-header">
        <div>
          <p className="eyebrow">Accounts</p>
          <h2>Users</h2>
          <p className="muted">
            {total ? `${total} matching` : "Search yourself by email, then Give Premium or Set to Free."}
          </p>
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
            {slugs.map((item) => (
              <option key={item} value={item}>
                {planLabel(item)}
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
              <th>Stripe</th>
              <th>Storage</th>
              <th>Clips</th>
              <th>Last sign-in</th>
              <th>Access</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => {
              const used = user.storageUsedBytes;
              const limit = user.storageLimitBytes;
              const percent = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
              const busy = busyId === user.id;
              const you = user.id === session?.user.id;
              return (
                <tr key={user.id}>
                  <td>
                    <strong>
                      {user.displayName || user.username || "No name"}
                      {you ? " · you" : ""}
                    </strong>
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
                      disabled={busy}
                      onChange={(event) => void changePlan(user, event.target.value)}
                      aria-label={`Plan for ${user.email || user.username || "user"}`}
                    >
                      {slugs.map((item) => (
                        <option key={item} value={item}>
                          {planLabel(item)}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <span className="muted">
                      {user.stripeStatus || (user.complimentary ? "comp" : "—")}
                      {user.cancelAtPeriodEnd ? " · canceling" : ""}
                      {user.currentPeriodEnd ? ` · ${formatClipDate(user.currentPeriodEnd)}` : ""}
                    </span>
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
                  <td>
                    <div className="row">
                      {isPaidPlan(user.planSlug) ? (
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
                      {user.stripeCustomerId || user.stripeStatus ? (
                        <select
                          defaultValue=""
                          disabled={busy}
                          aria-label={`Stripe actions for ${user.email || user.username || "user"}`}
                          onChange={(event) => {
                            const action = event.target.value;
                            event.target.value = "";
                            void runStripe(user, action);
                          }}
                        >
                          <option value="">Stripe</option>
                          {user.stripeCustomerId ? <option value="stripe">Open customer</option> : null}
                          {user.stripeStatus ? <option value="cancel">Cancel at period end</option> : null}
                          {user.stripeStatus ? <option value="extend">Extend trial</option> : null}
                        </select>
                      ) : null}
                    </div>
                  </td>
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
