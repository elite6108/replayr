import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../../lib/auth";
import {
  assignStaffRoles,
  createStaffInvite,
  fetchStaffInvites,
  fetchStaffMembers,
  fetchStaffRoles,
  patchStaffMember,
  revokeStaffInvite,
  setStaffMemberStatus,
  type StaffMember,
  type StaffRole,
} from "../../lib/staff";
import { useStaffPermissions } from "../../lib/staff";

export function AdminStaffPage() {
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const { can } = useStaffPermissions();
  const [members, setMembers] = useState<StaffMember[]>([]);
  const [roles, setRoles] = useState<StaffRole[]>([]);
  const [invites, setInvites] = useState<Array<{ id: string; email: string; status: string; roles: Array<{ name: string }> }>>([]);
  const [error, setError] = useState<string | null>(null);
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

  return (
    <section className="admin-section">
      <header className="admin-header">
        <div>
          <p className="eyebrow">People</p>
          <h2>Staff</h2>
          <p className="muted">Membership, invites, and effective permissions. Authorization is enforced by the Worker.</p>
        </div>
      </header>
      {error ? <p className="error">{error}</p> : null}
      {can("staff.members.invite") ? (
        <form
          className="admin-filters"
          onSubmit={(event) => {
            event.preventDefault();
            if (!email || !inviteRoles.length) return;
            void createStaffInvite(token, { email, roleIds: inviteRoles })
              .then(() => {
                setEmail("");
                return load();
              })
              .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Invite failed."));
          }}
        >
          <input value={email} onChange={(event) => setEmail(event.target.value)} placeholder="Email" type="email" required />
          <select
            multiple
            value={inviteRoles}
            onChange={(event) => setInviteRoles([...event.target.selectedOptions].map((option) => option.value))}
          >
            {assignable.map((role) => (
              <option key={role.id} value={role.id}>
                {role.name}
              </option>
            ))}
          </select>
          <button className="button" type="submit">
            Invite
          </button>
        </form>
      ) : null}
      {invites.length ? (
        <div className="staff-invite-list">
          {invites.map((invite) => (
            <p key={invite.id} className="muted">
              Pending: {invite.email} ({invite.roles.map((role) => role.name).join(", ")})
              {can("staff.members.invite") ? (
                <button type="button" className="button ghost" onClick={() => void revokeStaffInvite(token, invite.id).then(load)}>
                  Revoke
                </button>
              ) : null}
            </p>
          ))}
        </div>
      ) : null}
      <div className="analytics-table-wrap">
        <table className="analytics-table">
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
                  <button type="button" className="linkish" onClick={() => setSelected(member)}>
                    {member.displayName}
                  </button>
                  <div className="muted">{member.username ? `@${member.username}` : member.userId.slice(0, 8)}</div>
                </td>
                <td>{member.roles.map((role) => role.name).join(", ")}</td>
                <td>{member.status}</td>
                <td>{member.department || "—"}</td>
                <td>
                  {can("staff.members.suspend") && member.status === "active" ? (
                    <button type="button" onClick={() => void setStaffMemberStatus(token, member.id, "suspend").then(load)}>
                      Suspend
                    </button>
                  ) : null}
                  {can("staff.members.remove") && member.status !== "inactive" ? (
                    <button type="button" onClick={() => void setStaffMemberStatus(token, member.id, "deactivate").then(load)}>
                      Deactivate
                    </button>
                  ) : null}
                  {member.status !== "active" && can("staff.members.remove") ? (
                    <button type="button" onClick={() => void setStaffMemberStatus(token, member.id, "activate").then(load)}>
                      Activate
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {selected ? (
        <aside className="staff-drawer">
          <h3>{selected.displayName}</h3>
          <p className="muted">Effective: {selected.isSuperAdmin ? "all permissions (Super Admin)" : selected.permissions.join(", ") || "none"}</p>
          {can("staff.members.edit") ? (
            <form
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
              <button className="button" type="submit">
                Save
              </button>
            </form>
          ) : null}
          {can("staff.roles.assign") ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const data = new FormData(event.currentTarget);
                const roleIds = data.getAll("roleIds").map(String);
                void assignStaffRoles(token, selected.id, roleIds)
                  .then(() => {
                    setSelected(null);
                    return load();
                  })
                  .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Could not assign roles."));
              }}
            >
              <p>Roles</p>
              {assignable.map((role) => (
                <label key={role.id}>
                  <input type="checkbox" name="roleIds" value={role.id} defaultChecked={selected.roles.some((item) => item.id === role.id)} />
                  {role.name}
                </label>
              ))}
              <button className="button" type="submit">
                Update roles
              </button>
            </form>
          ) : null}
          <button type="button" className="button ghost" onClick={() => setSelected(null)}>
            Close
          </button>
        </aside>
      ) : null}
    </section>
  );
}
