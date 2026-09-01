import { FormEvent, useEffect, useMemo, useState } from "react";
import { Link, NavLink, useNavigate } from "react-router-dom";
import { Seo } from "../components/Seo";
import { SocialAvatar } from "../components/SocialAvatar";
import {
  acceptFolderInvite,
  createFolder,
  deleteFolderInvite,
  folderAccessLabel,
  folderRoleLabel,
  listFolders,
  listIncomingFolderInvites,
  listSharedFolders,
} from "../lib/api.folders";
import { useAuth } from "../lib/auth";
import type { Folder, FolderInvite } from "../lib/social-types";

export function FoldersPage() {
  const { session } = useAuth();
  const token = session?.access_token;
  const navigate = useNavigate();
  const [mine, setMine] = useState<Folder[]>([]);
  const [shared, setShared] = useState<Folder[]>([]);
  const [invites, setInvites] = useState<FolderInvite[]>([]);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"updated" | "name">("updated");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    if (!token) return;
    setError(null);
    try {
      const [nextMine, nextShared, nextInvites] = await Promise.all([
        listFolders(token),
        listSharedFolders(token),
        listIncomingFolderInvites(token),
      ]);
      setMine(nextMine);
      setShared(nextShared);
      setInvites(nextInvites);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load folders.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [token]);

  function filterSort(list: Folder[]) {
    const needle = query.trim().toLowerCase();
    const filtered = needle ? list.filter((folder) => folder.name.toLowerCase().includes(needle)) : list;
    return [...filtered].sort((a, b) =>
      sort === "name" ? a.name.localeCompare(b.name) : b.updatedAt.localeCompare(a.updatedAt),
    );
  }

  const visibleMine = useMemo(() => filterSort(mine), [mine, query, sort]);
  const visibleShared = useMemo(() => filterSort(shared), [shared, query, sort]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!token || !name.trim() || busy) return;
    setBusy(true);
    try {
      const folder = await createFolder(token, { name: name.trim(), description: description.trim() || undefined });
      setName("");
      setDescription("");
      navigate(`/folders/${folder.id}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create that folder.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page library-page folder-app">
      <Seo title="Folders — Replayr" description="Organize and share cloud clips." robots="noindex" />
      <LibraryFolderTabs />
      <div className="library-head">
        <div>
          <p className="eyebrow">Library</p>
          <h1>Folders</h1>
          <p className="muted">Create a folder to organize and share your best clips. Clips stay in your library.</p>
        </div>
      </div>
      {error ? <p className="error">{error}</p> : null}
      <form className="folder-create" onSubmit={(event) => void submit(event)}>
        <input value={name} maxLength={80} placeholder="New folder name" onChange={(event) => setName(event.target.value)} />
        <input
          value={description}
          maxLength={500}
          placeholder="Description optional"
          onChange={(event) => setDescription(event.target.value)}
        />
        <button className="btn primary" type="submit" disabled={!name.trim() || busy}>
          {busy ? "Creating…" : "Create folder"}
        </button>
      </form>
      <div className="folder-toolbar">
        <input value={query} placeholder="Search folders" onChange={(event) => setQuery(event.target.value)} />
        <select value={sort} onChange={(event) => setSort(event.target.value as "updated" | "name")}>
          <option value="updated">Recently updated</option>
          <option value="name">Name</option>
        </select>
      </div>
      {loading ? <p className="muted">Loading folders…</p> : null}
      {invites.length > 0 ? (
        <section className="folder-section">
          <h2>Invites</h2>
          <ul className="folder-invite-list">
            {invites.map((invite) => (
              <li key={invite.id}>
                <span>
                  <strong>{invite.inviter.displayName}</strong> invited you to{" "}
                  <strong>{invite.folderName || "a folder"}</strong> as {folderRoleLabel(invite.role)}
                </span>
                <span className="row">
                  <button
                    type="button"
                    className="btn primary sm"
                    onClick={() => {
                      if (!token) return;
                      void acceptFolderInvite(token, invite.folderId, invite.id).then((folder) => {
                        navigate(`/folders/${folder.id}`);
                      });
                    }}
                  >
                    Accept
                  </button>
                  <button
                    type="button"
                    className="btn sm"
                    onClick={() => {
                      if (!token) return;
                      void deleteFolderInvite(token, invite.folderId, invite.id).then(() => load());
                    }}
                  >
                    Decline
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : !loading ? (
        <p className="muted">No pending folder invites.</p>
      ) : null}
      <section className="folder-section">
        <h2>My Folders</h2>
        {visibleMine.length === 0 && !loading ? (
          <p className="muted">Create a folder to organize and share your best clips.</p>
        ) : (
          <div className="folder-grid">{visibleMine.map((folder) => <WebFolderCard key={folder.id} folder={folder} />)}</div>
        )}
      </section>
      <section className="folder-section">
        <h2>Shared with Me</h2>
        {visibleShared.length === 0 && !loading ? (
          <p className="muted">Folders shared with you will appear here.</p>
        ) : (
          <div className="folder-grid">
            {visibleShared.map((folder) => (
              <WebFolderCard key={folder.id} folder={folder} shared />
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

export function LibraryFolderTabs() {
  return (
    <nav className="folder-tabs" aria-label="Library">
      <NavLink to="/library" end>
        Clips
      </NavLink>
      <NavLink to="/library/folders">Folders</NavLink>
    </nav>
  );
}

function WebFolderCard({ folder, shared = false }: { folder: Folder; shared?: boolean }) {
  return (
    <Link className="folder-card" to={`/folders/${folder.id}`}>
      <div className="folder-card-cover">
        {folder.coverThumbnailUrl ? <img src={folder.coverThumbnailUrl} alt="" /> : <span>Folder</span>}
      </div>
      <strong>{folder.name}</strong>
      <span className="muted">
        {folder.clipCount === 1 ? "1 clip" : `${folder.clipCount} clips`} · {folderAccessLabel(folder)}
        {shared && folder.owner ? ` · ${folder.owner.displayName}` : ""}
      </span>
      {shared && folder.role !== "owner" && folder.role !== "public" ? (
        <span className="badge">{folderRoleLabel(folder.role)}</span>
      ) : null}
      {(folder.membersPreview ?? []).length > 0 ? (
        <div className="folder-card-avatars">
          {folder.membersPreview.map((person) => (
            <SocialAvatar key={person.id} name={person.displayName} avatarUrl={person.avatarUrl} size={22} />
          ))}
        </div>
      ) : null}
    </Link>
  );
}
