import { useEffect, useState } from "react";
import { fetchAdminStorage, updateAdminUser, type AdminStorageRow } from "../../lib/admin";
import { useAuth } from "../../lib/auth";
import { formatBytes, planLabel } from "../../lib/format";

export function AdminStoragePage() {
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const [accounts, setAccounts] = useState<AdminStorageRow[]>([]);
  const [approaching, setApproaching] = useState<AdminStorageRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load() {
    if (!token) return;
    setError(null);
    try {
      const next = await fetchAdminStorage(token);
      setAccounts(next.accounts);
      setApproaching(next.approaching);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load storage.");
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  async function setLimit(row: AdminStorageRow) {
    if (!token) return;
    const raw = window.prompt(
      `New cloud limit in GB for ${row.email || row.username || "this account"}`,
      String(Math.round(row.storageLimitBytes / 1024 ** 3) || 5),
    );
    if (raw == null) return;
    const gb = Number(raw);
    if (!Number.isFinite(gb) || gb < 0) {
      setError("Enter a storage limit in GB.");
      return;
    }
    setBusyId(row.userId);
    try {
      await updateAdminUser(token, row.userId, { storageLimitBytes: Math.round(gb * 1024 ** 3) });
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update quota.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="admin-section">
      <header className="admin-header">
        <div>
          <p className="eyebrow">Quota</p>
          <h2>Storage</h2>
          <p className="muted">Largest accounts first. Approaching means 80% of the current limit.</p>
        </div>
      </header>
      {error ? <p className="error">{error}</p> : null}
      {approaching.length ? (
        <div className="admin-callout">
          <strong>{approaching.length} approaching quota</strong>
          <p className="muted">{approaching.map((row) => row.email || row.username || row.userId).join(" · ")}</p>
        </div>
      ) : (
        <p className="muted">No accounts are at 80% of quota.</p>
      )}
      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Account</th>
              <th>Plan</th>
              <th>Used</th>
              <th>Clips</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {accounts.map((row) => (
              <tr key={row.userId}>
                <td>
                  <strong>{row.username ? `@${row.username}` : row.email || row.userId}</strong>
                  <span className="muted">{row.email}</span>
                </td>
                <td>{planLabel(row.planSlug)}</td>
                <td>
                  <div className={`admin-meter${row.percent >= 80 ? " hot" : ""}`}>
                    <span style={{ width: `${row.percent}%` }} />
                  </div>
                  <span className="muted">
                    {formatBytes(row.storageUsedBytes)} / {formatBytes(row.storageLimitBytes)} · {row.percent}%
                  </span>
                </td>
                <td>{row.clipCount}</td>
                <td>
                  <button className="btn" type="button" disabled={busyId === row.userId} onClick={() => void setLimit(row)}>
                    Set limit
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
