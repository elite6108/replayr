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
import { AdminPageHeader } from "./components/AdminPageHeader";
import { AdminSheet } from "./components/AdminSheet";

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
    <section className="admin-dash">
      <AdminPageHeader
        eyebrow="Access"
        title="Roles & Permissions"
        description="Custom roles can only include permissions you already have, unless you are Super Admin."
        actions={
          can("staff.roles.create") ? (
            <button className="admin-btn primary" type="button" onClick={() => setCreating(true)}>
              New role
            </button>
          ) : null
        }
      />
      {error ? <p className="error">{error}</p> : null}
      <div className="admin-role-grid">
        {roles.map((role) => (
          <article key={role.id} className="admin-panel admin-role-card">
            <header>
              <div>
                <h3>{role.name}</h3>
                <p className="muted">
                  {role.slug}
                  {role.isSystem ? " · system" : ""}
                  {role.isSuperAdmin ? " · super admin" : ""}
                </p>
              </div>
              {role.isSuperAdmin ? <span className="admin-status is-active">All keys</span> : <span className="admin-status">{role.permissions.length} keys</span>}
            </header>
            {role.description ? <p className="muted">{role.description}</p> : null}
            <p className="admin-role-count">{role.memberCount ?? 0} members</p>
            <div className="admin-row-actions">
              {can("staff.roles.edit") && !role.isSuperAdmin ? (
                <button type="button" className="admin-btn ghost" onClick={() => setEditing(role)}>
                  Edit
                </button>
              ) : null}
              {can("staff.roles.create") && !role.isSuperAdmin ? (
                <button type="button" className="admin-btn ghost" onClick={() => void duplicateStaffRole(token, role.id).then(load)}>
                  Duplicate
                </button>
              ) : null}
              {can("staff.roles.delete") && !role.isSystem ? (
                <button
                  type="button"
                  className="admin-btn danger"
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
            </div>
          </article>
        ))}
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
    <AdminSheet title={role ? `Edit ${role.name}` : "New role"} subtitle="Toggle only the keys this role should grant." onClose={onClose}>
      {error ? <p className="error">{error}</p> : null}
      <form className="admin-form">
        <label>
          Name
          <input value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label>
          Description
          <input value={description} onChange={(event) => setDescription(event.target.value)} />
        </label>
      </form>
      {catalog.map(([category, items]) => (
        <fieldset key={category} className="admin-perm-group">
          <legend>{category}</legend>
          <div className="admin-check-list">
            {items.map((item) => (
              <label key={item.key} className="admin-check">
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
                <span>
                  <strong>{item.label}</strong>
                  {item.description ? <small>{item.description}</small> : <small>{item.key}</small>}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      ))}
      <div className="admin-row-actions">
        <button
          className="admin-btn primary"
          type="button"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void onSave({ name, description, permissions: keys })
              .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Could not save role."))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? "Saving…" : "Save role"}
        </button>
        <button className="admin-btn ghost" type="button" onClick={onClose}>
          Cancel
        </button>
      </div>
    </AdminSheet>
  );
}
