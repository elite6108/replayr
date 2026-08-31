import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AuthCard } from "../components/common/AuthCard";
import { ClipGrid } from "../components/common/ClipGrid";
import { PageHeader } from "../components/common/PageHeader";
import { FolderCard } from "../components/library/FolderCard";
import { LibraryTabs } from "../components/library/LibraryTabs";
import { useAuthStore } from "../stores/authStore";
import { folderRoleLabel } from "../services/api.folders";
import { useFolderStore } from "../stores/folderStore";

export function FoldersPage() {
  const navigate = useNavigate();
  const configured = useAuthStore((state) => state.configured);
  const user = useAuthStore((state) => state.user);
  const folders = useFolderStore((state) => state.folders);
  const sharedFolders = useFolderStore((state) => state.sharedFolders);
  const incomingInvites = useFolderStore((state) => state.incomingInvites);
  const loading = useFolderStore((state) => state.loading);
  const error = useFolderStore((state) => state.error);
  const refresh = useFolderStore((state) => state.refresh);
  const create = useFolderStore((state) => state.create);
  const acceptInvite = useFolderStore((state) => state.acceptInvite);
  const declineInvite = useFolderStore((state) => state.declineInvite);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const userId = user?.id;

  useEffect(() => {
    if (userId) void refresh();
  }, [refresh, userId]);

  async function submit() {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    const folder = await create(trimmed, description.trim() || undefined);
    setBusy(false);
    if (folder) {
      setCreating(false);
      setName("");
      setDescription("");
      navigate(`/library/folders/${folder.id}`);
    }
  }

  return (
    <>
      <PageHeader title="Library" subtitle="Folders organize cloud clips. They are not folders on this PC.">
        <LibraryTabs />
        {user ? (
          <button type="button" className="btn primary" onClick={() => setCreating(true)}>
            + New Folder
          </button>
        ) : null}
      </PageHeader>
      {!configured ? (
        <section className="panel">
          <p>
            Copy <code>.env.example</code> to <code>.env</code> and set <code>VITE_SUPABASE_URL</code> and{" "}
            <code>VITE_SUPABASE_ANON_KEY</code>.
          </p>
        </section>
      ) : !user ? (
        <AuthCard />
      ) : (
        <div className="stack">
          {error ? <div className="error-text">{error}</div> : null}
          {loading && folders.length === 0 && sharedFolders.length === 0 ? <p className="muted">Loading folders…</p> : null}
          {incomingInvites.length > 0 ? (
            <section className="panel stack">
              <div className="panel-head">
                <h2>Invites</h2>
                <span className="badge">{incomingInvites.length}</span>
              </div>
              <ul className="folder-invite-list">
                {incomingInvites.map((invite) => (
                  <li key={invite.id} className="folder-invite-row">
                    <span>
                      <strong>{invite.inviter.displayName}</strong> invited you to{" "}
                      <strong>{invite.folderName || "a folder"}</strong>
                      <span className="muted"> as {folderRoleLabel(invite.role)}</span>
                    </span>
                    <div className="row">
                      <button
                        type="button"
                        className="btn primary sm"
                        onClick={() => {
                          void acceptInvite(invite.folderId, invite.id).then((folder) => {
                            if (folder) navigate(`/library/folders/${folder.id}`);
                          });
                        }}
                      >
                        Accept
                      </button>
                      <button type="button" className="btn sm" onClick={() => void declineInvite(invite.folderId, invite.id)}>
                        Decline
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {!loading && folders.length === 0 ? (
            <ClipGrid title="No folders yet" body="Create a folder, then add cloud clips. Clips stay in your library." />
          ) : folders.length > 0 ? (
            <section className="panel flush">
              <div className="panel-head">
                <h2>My Folders</h2>
                <span className="badge">{folders.length}</span>
              </div>
              <div className="folder-grid">
                {folders.map((folder) => (
                  <FolderCard key={folder.id} folder={folder} />
                ))}
              </div>
            </section>
          ) : null}
          <section className="panel flush">
            <div className="panel-head">
              <h2>Shared with Me</h2>
              <span className="badge">{sharedFolders.length}</span>
            </div>
            {sharedFolders.length === 0 ? (
              <p className="muted folder-empty-note">Folders others share with you show up here.</p>
            ) : (
              <div className="folder-grid">
                {sharedFolders.map((folder) => (
                  <FolderCard key={folder.id} folder={folder} shared />
                ))}
              </div>
            )}
          </section>
        </div>
      )}
      {creating ? (
        <div className="send-overlay" role="dialog" aria-modal="true" aria-label="New folder">
          <button type="button" className="player-backdrop" aria-label="Close" onClick={() => setCreating(false)} />
          <section className="send-sheet">
            <h2>New Folder</h2>
            <div className="field">
              <label htmlFor="folder-name">Name</label>
              <input
                id="folder-name"
                value={name}
                maxLength={80}
                autoFocus
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void submit();
                }}
              />
            </div>
            <div className="field">
              <label htmlFor="folder-description">Description optional</label>
              <input
                id="folder-description"
                value={description}
                maxLength={500}
                onChange={(event) => setDescription(event.target.value)}
              />
            </div>
            <div className="row">
              <button type="button" className="btn primary" disabled={!name.trim() || busy} onClick={() => void submit()}>
                {busy ? "Creating…" : "Create"}
              </button>
              <button type="button" className="btn" onClick={() => setCreating(false)}>
                Cancel
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
