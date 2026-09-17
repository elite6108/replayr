import { Link } from "react-router-dom";
import type { AdminUserRow } from "../../../lib/admin";
import { formatRelativeTime, initials } from "./adminFormat";

export function RecentUsersCard({ users, loading, error }: { users: AdminUserRow[]; loading: boolean; error: string | null }) {
  return (
    <section className="admin-panel">
      <header className="admin-panel-head">
        <h3>Recent Signups</h3>
        <Link to="/admin/users">View all</Link>
      </header>
      {error ? <p className="error">{error}</p> : null}
      {loading ? <p className="muted">Loading accounts…</p> : null}
      {!loading && !error && users.length === 0 ? <p className="muted">No recent accounts.</p> : null}
      <ul className="admin-person-list">
        {users.map((user) => {
          const name = user.displayName || user.username || user.email || "Player";
          return (
            <li key={user.id}>
              <span className="admin-avatar">{initials(name)}</span>
              <span>
                <strong>{user.username ? `@${user.username}` : name}</strong>
                <small>{user.email || "No email"}</small>
              </span>
              <em>{formatRelativeTime(user.createdAt)}</em>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
