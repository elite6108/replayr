import { useEffect, useState } from "react";
import { fetchBlockedAccounts, unblockUser } from "../../services/api.safety";
import type { BlockedAccount } from "../../services/social-types";
import { useAuthStore } from "../../stores/authStore";

export function BlockedAccounts() {
  const token = useAuthStore((state) => state.session?.access_token);
  const [users, setUsers] = useState<BlockedAccount[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    void fetchBlockedAccounts(token)
      .then((next) => {
        if (!cancelled) setUsers(next);
      })
      .catch((caught) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Could not load blocked accounts.");
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (!token) return null;

  async function unblock(userId: string) {
    if (!token) return;
    setBusyId(userId);
    setError(null);
    try {
      await unblockUser(token, userId);
      setUsers((current) => (current ?? []).filter((user) => user.id !== userId));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not unblock that account.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="settings-group">
      <div className="settings-group-label">Blocked accounts</div>
      {error ? <p className="error-text">{error}</p> : null}
      {users == null ? (
        <p className="muted">Loading…</p>
      ) : users.length === 0 ? (
        <div className="setting-row">
          <span className="muted">You have not blocked anyone.</span>
        </div>
      ) : (
        users.map((user) => (
          <div className="setting-row" key={user.id}>
            <span>
              {user.displayName}
              {user.username ? <small> @{user.username}</small> : null}
            </span>
            <button className="btn sm" type="button" disabled={busyId === user.id} onClick={() => void unblock(user.id)}>
              Unblock
            </button>
          </div>
        ))
      )}
    </div>
  );
}
