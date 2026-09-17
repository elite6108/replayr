import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../../lib/auth";
import {
  createStaffRole,
  deleteStaffRole,
  duplicateStaffRole,
  fetchStaffRoles,
  patchStaffRole,
  type PermissionCatalogItem,
  type StaffRole,
  useStaffPermissions,
} from "../../lib/staff";

export function AdminRolesPage() {
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const { can } = useStaffPermissions();
  const [roles, setRoles] = useState<StaffRole[]>([]);
  const [catalog, setCatalog] = useState<PermissionCatalogItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<StaffRole | null>(null);
  const [creating, setCreating] = useState(false);

  async function load() {
    if (!token) return;
    try {
      const body = await fetchStaffRoles(token);
      setRoles(body.roles);
      setCatalog(body.catalog);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load roles.");
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const grouped = useMemo(() => {
    const map = new Map<string, PermissionCatalogItem[]>();
    for (const item of catalog) {
      const list = map.get(item.category) ?? [];
      list.push(item);
      map.set(item.category, list);
    }
    return [...map.entries()];
  }, [catalog]);

  return (
    <section className="admin-section">
      <header className="admin-header">
        <div>
          <p className="eyebrow">Access</p>
          <h2>Roles</h2>
          <p className="muted">Custom roles can only include permissions you already have, unless you are Super Admin.</p>
        </div>
        {can("staff.roles.create") ? (
          <button className="button" type="button" onClick={() => setCreating(true)}>
            New role
          </button>
        ) : null}
      </header>
      {error ? <p className="error">{error}</p> : null}
      <div className="analytics-table-wrap">
        <table className="analytics-table">
          <thead>
            <tr>
              <th>Role</th>
              <th>Members</th>
              <th>Permissions</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {roles.map((role) => (
              <tr key={role.id}>
                <td>
                  <strong>{role.name}</strong>
                  <div className="muted">{role.slug}{role.isSystem ? " · system" : ""}</div>
                </td>
                <td>{role.memberCount ?? 0}</td>
                <td>{role.isSuperAdmin ? "All keys" : `${role.permissions.length} keys`}</td>
                <td>
                  {can("staff.roles.edit") && !role.isSuperAdmin ? (
                    <button type="button" onClick={() => setEditing(role)}>
                      Edit
                    </button>
                  ) : null}
                  {can("staff.roles.create") && !role.isSuperAdmin ? (
                    <button type="button" onClick={() => void duplicateStaffRole(token, role.id).then(load)}>
                      Duplicate
                    </button>
                  ) : null}
                  {can("staff.roles.delete") && !role.isSystem ? (
                    <button
                      type="button"
                      onClick={() => {
                        const ok = window.confirm("Delete this role? Assigned members must be reassigned or cleared.");
                        if (!ok) return;
                        void deleteStaffRole(token, role.id, { clearAssignments: true })
                          .then(load)
                          .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Delete failed."));
                      }}
                    >
                      Delete
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing || creating ? (
        <RoleEditor
          catalog={grouped}
          role={editing}
          onClose={() => {
            setEditing(null);
            setCreating(false);
          }}
          onSave={async (payload) => {
            if (editing) await patchStaffRole(token, editing.id, payload);
            else await createStaffRole(token, { name: payload.name || "New role", permissions: payload.permissions || [] });
            setEditing(null);
            setCreating(false);
            await load();
          }}
        />
      ) : null}
    </section>
  );
}

function RoleEditor({
  catalog,
  role,
  onClose,
  onSave,
}: {
  catalog: Array<[string, PermissionCatalogItem[]]>;
  role: StaffRole | null;
  onClose: () => void;
  onSave: (payload: { name?: string; description?: string; permissions?: string[] }) => Promise<void>;
}) {
  const [name, setName] = useState(role?.name ?? "");
  const [description, setDescription] = useState(role?.description ?? "");
  const [keys, setKeys] = useState<string[]>(role?.permissions ?? ["staff.access"]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <aside className="staff-drawer">
      <h3>{role ? `Edit ${role.name}` : "New role"}</h3>
      {error ? <p className="error">{error}</p> : null}
      <label>
        Name
        <input value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <label>
        Description
        <input value={description} onChange={(event) => setDescription(event.target.value)} />
      </label>
      {catalog.map(([category, items]) => (
        <fieldset key={category}>
          <legend>{category}</legend>
          {items.map((item) => (
            <label key={item.key}>
              <input
                type="checkbox"
                checked={keys.includes(item.key)}
                disabled={item.key === "staff.roles.manage_all"}
                onChange={(event) => {
                  setKeys((current) =>
                    event.target.checked ? [...current, item.key] : current.filter((key) => key !== item.key),
                  );
                }}
              />
              {item.label}
            </label>
          ))}
        </fieldset>
      ))}
      <button
        className="button"
        type="button"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void onSave({ name, description, permissions: keys })
            .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Could not save role."))
            .finally(() => setBusy(false));
        }}
      >
        Save
      </button>
      <button className="button ghost" type="button" onClick={onClose}>
        Cancel
      </button>
    </aside>
  );
}
