import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../../lib/auth";
import {
  assignStaffRoles,
  createStaffInvite,
  fetchStaffInvites,
  fetchStaffMembers,
  fetchStaffRoles,
  patchStaffMember,
  resendStaffInvite,
  revokeStaffInvite,
  setStaffMemberStatus,
  type StaffMember,
  type StaffRole,
  useStaffPermissions,
} from "../../lib/staff";
import { AdminPageHeader } from "./components/AdminPageHeader";
import { AdminSheet } from "./components/AdminSheet";
import { initials } from "./components/adminFormat";

export function AdminStaffPage() {
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const { can } = useStaffPermissions();
  const [members, setMembers] = useState<StaffMember[]>([]);
  const [roles, setRoles] = useState<StaffRole[]>([]);
  const [invites, setInvites] = useState<Array<{ id: string; email: string; status: string; roles: Array<{ name: string }> }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [inviteRoles, setInviteRoles] = useState<string[]>([]);
  const [selected, setSelected] = useState<StaffMember | null>(null);

  async function load() {
    if (!token) return;
    setError(null);
    try {
      const [people, roleList, inviteList] = await Promise.all([
        fetchStaffMembers(token),
        fetchStaffRoles(token),
        fetchStaffInvites(token),
      ]);
      setMembers(people.members);
      setRoles(roleList.roles);
      setInvites(inviteList.invites.filter((row) => row.status === "pending"));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load staff.");
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const assignable = useMemo(() => roles.filter((role) => !role.isSuperAdmin || can("staff.roles.manage_all")), [roles, can]);

  function toggleInviteRole(id: string) {
    setInviteRoles((current) => (current.includes(id) ? current.filter((roleId) => roleId !== id) : [...current, id]));
  }

  return (
    <section className="admin-dash">
      <AdminPageHeader
        eyebrow="People"
        title="Staff"
        description="Membership, invites, and effective permissions. Authorization is enforced by the Worker."
      />
      {error ? <p className="error">{error}</p> : null}
      {notice ? <p className="admin-notice">{notice}</p> : null}

      {can("staff.members.invite") ? (
        <form
          className="admin-panel admin-invite"
          onSubmit={(event) => {
            event.preventDefault();
            if (!email || !inviteRoles.length) return;
            setNotice(null);
            void createStaffInvite(token, { email, roleIds: inviteRoles })
              .then((result) => {
                setEmail("");
                setInviteRoles([]);
                setNotice(
                  result.delivery.sent
                    ? "Staff invitation emailed."
                    : result.delivery.warning || "Invite saved, but the email could not be sent.",
                );
                return load();
              })
              .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Invite failed."));
          }}
        >
          <div>
            <h3>Invite staff</h3>
            <p className="muted">Send a role-scoped invite. Recipients join with only the keys on those roles.</p>
          </div>
          <div className="admin-invite-row">
            <input value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@replayr.tv" type="email" required />
            <button className="admin-btn primary" type="submit" disabled={!email || !inviteRoles.length}>
              Invite
            </button>
          </div>
          <div className="admin-chip-row" role="group" aria-label="Invite roles">
            {assignable.map((role) => (
              <button
                key={role.id}
                type="button"
                className={`admin-chip${inviteRoles.includes(role.id) ? " is-on" : ""}`}
                onClick={() => toggleInviteRole(role.id)}
              >
                {role.name}
              </button>
            ))}
          </div>
        </form>
      ) : null}

      {invites.length ? (
        <section className="admin-panel">
          <header className="admin-panel-head">
            <h3>Pending invites</h3>
          </header>
          <ul className="admin-invite-pending">
            {invites.map((invite) => (
              <li key={invite.id}>
                <span>
                  <strong>{invite.email}</strong>
                  <small>{invite.roles.map((role) => role.name).join(", ") || "No roles"}</small>
                </span>
                {can("staff.members.invite") ? (
                  <span className="admin-row-actions">
                    <button
                      type="button"
                      className="admin-btn ghost"
                      onClick={() => {
                        setNotice(null);
                        void resendStaffInvite(token, invite.id)
                          .then((result) =>
                            setNotice(
                              result.delivery.sent
                                ? `Invitation re-sent to ${invite.email}.`
                                : result.delivery.warning || "The invitation email could not be sent.",
                            ),
                          )
                          .catch((caught: unknown) =>
                            setError(caught instanceof Error ? caught.message : "Could not resend invitation."),
                          );
                      }}
                    >
                      Resend
                    </button>
                    <button type="button" className="admin-btn ghost" onClick={() => void revokeStaffInvite(token, invite.id).then(load)}>
                      Revoke
                    </button>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="admin-panel admin-table-card">
        <header className="admin-panel-head">
          <h3>Members</h3>
          <span className="muted">{members.length} people</span>
        </header>
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Roles</th>
                <th>Status</th>
                <th>Department</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {members.map((member) => (
                <tr key={member.id}>
                  <td>
                    <button type="button" className="admin-person-btn" onClick={() => setSelected(member)}>
                      <span className="admin-avatar">{initials(member.displayName)}</span>
                      <span>
                        <strong>{member.displayName}</strong>
                        <small>{member.username ? `@${member.username}` : member.userId.slice(0, 8)}</small>
                      </span>
                    </button>
                  </td>
                  <td>
                    <span className="admin-chip-row compact">
                      {member.roles.map((role) => (
                        <span key={role.id} className="admin-chip is-static">
                          {role.name}
                        </span>
                      ))}
                      {!member.roles.length ? "—" : null}
                    </span>
                  </td>
                  <td>
                    <span className={`admin-status is-${member.status}`}>{member.status}</span>
                  </td>
                  <td>{member.department || "—"}</td>
                  <td>
                    <span className="admin-row-actions">
                      {can("staff.members.suspend") && member.status === "active" ? (
                        <button type="button" className="admin-btn ghost" onClick={() => void setStaffMemberStatus(token, member.id, "suspend").then(load)}>
                          Suspend
                        </button>
                      ) : null}
                      {can("staff.members.remove") && member.status !== "inactive" ? (
                        <button type="button" className="admin-btn danger" onClick={() => void setStaffMemberStatus(token, member.id, "deactivate").then(load)}>
                          Deactivate
                        </button>
                      ) : null}
                      {member.status !== "active" && can("staff.members.remove") ? (
                        <button type="button" className="admin-btn primary" onClick={() => void setStaffMemberStatus(token, member.id, "activate").then(load)}>
                          Activate
                        </button>
                      ) : null}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {selected ? (
        <AdminSheet
          title={selected.displayName}
          subtitle={selected.isSuperAdmin ? "All permissions (Super Admin)" : selected.permissions.join(", ") || "No effective permissions"}
          onClose={() => setSelected(null)}
        >
          {can("staff.members.edit") ? (
            <form
              className="admin-form"
              onSubmit={(event) => {
                event.preventDefault();
                const data = new FormData(event.currentTarget);
                void patchStaffMember(token, selected.id, {
                  displayName: String(data.get("displayName") || selected.displayName),
                  jobTitle: String(data.get("jobTitle") || "") || null,
                  department: String(data.get("department") || "") || null,
                }).then(() => {
                  setSelected(null);
                  return load();
                });
              }}
            >
              <label>
                Display name
                <input name="displayName" defaultValue={selected.displayName} />
              </label>
              <label>
                Job title
                <input name="jobTitle" defaultValue={selected.jobTitle ?? ""} />
              </label>
              <label>
                Department
                <input name="department" defaultValue={selected.department ?? ""} />
              </label>
              <button className="admin-btn primary" type="submit">
                Save profile
              </button>
            </form>
          ) : null}
          {can("staff.roles.assign") ? (
            <form
              className="admin-form"
              onSubmit={(event) => {
                event.preventDefault();
                const data = new FormData(event.currentTarget);
                const roleIds = data.getAll("roleIds").map(String);
                void assignStaffRoles(token, selected.id, roleIds)
                  .then((result) => {
                    if (result.delivery) {
                      setNotice(
                        result.delivery.sent
                          ? "Roles updated and the member was emailed."
                          : result.delivery.warning || "Roles updated, but the email could not be sent.",
                      );
                    }
                    setSelected(null);
                    return load();
                  })
                  .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Could not assign roles."));
              }}
            >
              <p className="admin-form-label">Roles</p>
              <div className="admin-check-list">
                {assignable.map((role) => (
                  <label key={role.id} className="admin-check">
                    <input type="checkbox" name="roleIds" value={role.id} defaultChecked={selected.roles.some((item) => item.id === role.id)} />
                    <span>{role.name}</span>
                  </label>
                ))}
              </div>
              <button className="admin-btn primary" type="submit">
                Update roles
              </button>
            </form>
          ) : null}
        </AdminSheet>
      ) : null}
    </section>
  );
}
