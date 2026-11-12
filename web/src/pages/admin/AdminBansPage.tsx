import { useEffect, useState, type FormEvent } from "react";
import { createAccessBan, fetchAccessBans, liftAccessBan, type AccessBan } from "../../lib/admin";
import { useAuth } from "../../lib/auth";
import { formatClipDate } from "../../lib/format";
import { AdminPageHeader } from "./components/AdminPageHeader";

export function AdminBansPage() {
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const [bans, setBans] = useState<AccessBan[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [accountId, setAccountId] = useState("");
  const [accountReason, setAccountReason] = useState("");
  const [ip, setIp] = useState("");
  const [ipReason, setIpReason] = useState("");

  async function load() {
    if (!token) return;
    try {
      const body = await fetchAccessBans(token);
      setBans(body.bans);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load bans.");
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  async function banAccount(event: FormEvent) {
    event.preventDefault();
    const userId = accountId.trim();
    const reason = accountReason.trim();
    if (!token || !userId || !reason) return;
    if (!window.confirm("Ban this account? They will not be able to use Replayr.")) return;
    setBusyId("account");
    try {
      await createAccessBan(token, { kind: "account", userId, reason });
      setAccountId("");
      setAccountReason("");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not ban that account.");
    } finally {
      setBusyId(null);
    }
  }

  async function banIp(event: FormEvent) {
    event.preventDefault();
    const address = ip.trim();
    const reason = ipReason.trim();
    if (!token || !address || !reason) return;
    if (!window.confirm(`Block ${address}? Visitors from that address will not reach Replayr.`)) return;
    setBusyId("ip");
    try {
      await createAccessBan(token, { kind: "ip", ip: address, reason });
      setIp("");
      setIpReason("");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not ban that IP address.");
    } finally {
      setBusyId(null);
    }
  }

  async function lift(ban: AccessBan) {
    if (!token) return;
    const who = ban.kind === "account" ? ban.label : ban.subject;
    if (!window.confirm(`Lift the ban on ${who}?`)) return;
    setBusyId(ban.id);
    try {
      await liftAccessBan(token, ban.id);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not lift that ban.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="admin-page">
      <AdminPageHeader
        eyebrow="People"
        title="Bans"
        description="Block an account or a public IP address. The reason is kept for staff and is not shown to the person who is blocked."
      />
      {error ? <p className="error">{error}</p> : null}
      <form className="admin-filters" onSubmit={(event) => void banAccount(event)}>
        <input
          value={accountId}
          onChange={(event) => setAccountId(event.target.value)}
          placeholder="Account id"
          aria-label="Account id"
        />
        <input
          value={accountReason}
          onChange={(event) => setAccountReason(event.target.value)}
          placeholder="Reason for staff"
          aria-label="Account ban reason"
          maxLength={200}
        />
        <button className="admin-btn primary" type="submit" disabled={busyId === "account"}>
          Ban account
        </button>
      </form>
      <form className="admin-filters" onSubmit={(event) => void banIp(event)}>
        <input
          value={ip}
          onChange={(event) => setIp(event.target.value)}
          placeholder="Public IP address"
          aria-label="IP address"
        />
        <input
          value={ipReason}
          onChange={(event) => setIpReason(event.target.value)}
          placeholder="Reason for staff"
          aria-label="IP ban reason"
          maxLength={200}
        />
        <button className="admin-btn primary" type="submit" disabled={busyId === "ip"}>
          Ban IP
        </button>
      </form>
      <div className="admin-panel admin-table-card">
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Target</th>
                <th>Kind</th>
                <th>Reason</th>
                <th>Since</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {bans.map((ban) => (
                <tr key={ban.id}>
                  <td>
                    <strong>{ban.label}</strong>
                    {ban.kind === "account" ? <span className="muted">{ban.subject}</span> : null}
                  </td>
                  <td>{ban.kind === "account" ? "Account" : "IP"}</td>
                  <td>{ban.reason}</td>
                  <td>{formatClipDate(ban.createdAt)}</td>
                  <td>
                    <button className="btn" type="button" disabled={busyId === ban.id} onClick={() => void lift(ban)}>
                      Lift ban
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {bans.length === 0 ? <p className="muted admin-empty">No active bans.</p> : null}
        </div>
      </div>
    </section>
  );
}
