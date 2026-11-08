import { useEffect, useState } from "react";
import { fetchBlockedAccounts, unblockUser } from "../lib/api.safety";
import { useAuth } from "../lib/auth";
import type { BlockedAccount } from "../lib/social-types";

export function BlockedAccounts() {
  const { session } = useAuth();
  const token = session?.access_token;
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
    <section>
      <h2>Blocked accounts</h2>
      {error ? <p className="error">{error}</p> : null}
      {users == null ? (
        <p className="muted">Loading…</p>
      ) : users.length === 0 ? (
        <p className="muted">You have not blocked anyone.</p>
      ) : (
        <ul className="person-list">
          {users.map((user) => (
            <li key={user.id}>
              <span>{user.displayName}</span>
              {user.username ? <span className="muted"> @{user.username}</span> : null}
              <button className="btn" type="button" disabled={busyId === user.id} onClick={() => void unblock(user.id)}>
                Unblock
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
