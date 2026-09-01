import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { PlayerVideo } from "../components/ReplayrWatermark";
import { Seo } from "../components/Seo";
import { SocialAvatar } from "../components/SocialAvatar";
import { fetchLibrary, type ManagedClip } from "../lib/api";
import {
  addFolderClips,
  createFolderEdit,
  createFolderInvite,
  deleteFolder,
  deleteFolderEdit,
  deleteFolderInvite,
  disableFolderPublicLink,
  duplicateFolderEdit,
  enableFolderPublicLink,
  folderAccessLabel,
  folderRoleLabel,
  getFolder,
  isFolderEditConflict,
  leaveFolder,
  listFolderActivity,
  listFolderEdits,
  listFolderInvites,
  listFolderMembers,
  playFolderClip,
  regenerateFolderPublicLink,
  removeFolderClip,
  removeFolderMember,
  renderFolderEdit,
  transferFolderOwnership,
  updateFolder,
  updateFolderEdit,
  updateFolderMemberRole,
  updateFolderPublicDownloads,
} from "../lib/api.folders";
import { searchUsers } from "../lib/api.friends";
import { useAuth } from "../lib/auth";
import { formatDurationMs } from "../lib/format";
import type {
  FolderActivity,
  FolderClip,
  FolderDetail,
  FolderEdit,
  FolderInvite,
  FolderMember,
  FolderMemberRole,
  FolderPublicShare,
  SocialUser,
} from "../lib/social-types";
import { LibraryFolderTabs } from "./FoldersPage";

export function FolderPage() {
  const { folderId = "" } = useParams();
  const { session } = useAuth();
  const token = session?.access_token;
  const navigate = useNavigate();
  const [folder, setFolder] = useState<FolderDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [playback, setPlayback] = useState<{ title: string; url: string } | null>(null);
  const [panel, setPanel] = useState<"share" | "add" | "edits" | "activity" | null>(null);
  const [editClip, setEditClip] = useState<FolderClip | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    if (!token) return;
    try {
      setFolder(await getFolder(token, folderId));
      setError(null);
    } catch (caught) {
      setFolder(null);
      setError(caught instanceof Error ? caught.message : "That folder was not found.");
      if (caught instanceof Error && /not found|permission/i.test(caught.message)) {
        navigate("/library/folders", { replace: true });
      }
    }
  }

  useEffect(() => {
    void load();
  }, [folderId, token]);

  async function play(clip: FolderClip) {
    if (!token || clip.status !== "ready") return;
    try {
      setPlayback({ title: clip.title || "Untitled clip", url: await playFolderClip(token, folderId, clip.id) });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not play that clip.");
    }
  }

  async function rename() {
    if (!token || !folder) return;
    const name = window.prompt("Folder name", folder.name)?.trim();
    if (!name || name === folder.name) return;
    try {
      setFolder(await updateFolder(token, folderId, { name }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not rename that folder.");
    }
  }

  const permissions = folder?.permissions;

  return (
    <main className="page library-page folder-app">
      <Seo
        title={folder ? `${folder.name} — Replayr` : "Folder — Replayr"}
        description={folder?.description || "Organize and share cloud clips."}
        robots="noindex"
      />
      <LibraryFolderTabs />
      {error ? <p className="error">{error}</p> : null}
      {notice ? <p className="ok">{notice}</p> : null}
      {!folder ? (
        <p className="muted">Loading folder…</p>
      ) : (
        <>
          <header className="library-head">
            <div>
              <p className="muted">
                <Link to="/library/folders">Folders</Link> / {folder.name}
              </p>
              <h1>{folder.name}</h1>
              {folder.description ? <p className="muted">{folder.description}</p> : null}
              <div className="row">
                <span className="badge">{folderAccessLabel(folder)}</span>
                {folder.role !== "owner" && folder.role !== "public" ? (
                  <span className="badge">{folderRoleLabel(folder.role)}</span>
                ) : null}
                <span className="muted">{folder.clipCount === 1 ? "1 clip" : `${folder.clipCount} clips`}</span>
                {folder.owner ? <span className="muted">{folder.owner.displayName}</span> : null}
              </div>
            </div>
          </header>
          <div className="row">
            {permissions?.addClips ? (
              <button type="button" className="btn primary" onClick={() => setPanel("add")}>
                Add Clips
              </button>
            ) : null}
            <button type="button" className="btn" onClick={() => setPanel("share")}>
              Share
            </button>
            {permissions?.manageFolder ? (
              <button type="button" className="btn" onClick={() => void rename()}>
                Rename
              </button>
            ) : null}
            <button type="button" className="btn" onClick={() => setPanel("activity")}>
              Activity
            </button>
            {permissions?.deleteFolder ? (
              <button
                type="button"
                className="btn danger"
                onClick={() => {
                  if (!token) return;
                  if (!window.confirm(`Delete “${folder.name}”? Clips stay in your library.`)) return;
                  void deleteFolder(token, folderId).then(() => navigate("/library/folders"));
                }}
              >
                Delete folder
              </button>
            ) : null}
            {folder.role !== "owner" ? (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  if (!token) return;
                  if (!window.confirm(`Leave “${folder.name}”?`)) return;
                  void leaveFolder(token, folderId).then(() => navigate("/library/folders"));
                }}
              >
                Leave folder
              </button>
            ) : null}
          </div>
          {playback ? (
            <section className="public-folder-player">
              <PlayerVideo showWatermark>
                <video src={playback.url} controls playsInline autoPlay />
              </PlayerVideo>
              <strong>{playback.title}</strong>
            </section>
          ) : null}
          {folder.clips.length === 0 ? (
            <p className="muted">Add clips to start building this folder.</p>
          ) : (
            <ul className="clip-grid">
              {folder.clips.map((clip) => (
                <li key={clip.id}>
                  <article className="web-clip-card">
                    <button type="button" className="clip-open" disabled={clip.status !== "ready"} onClick={() => void play(clip)}>
                      <div className="clip-thumb">
                        {clip.thumbnailUrl ? <img src={clip.thumbnailUrl} alt="" /> : <span>Clip</span>}
                        {clip.durationMs ? <span className="clip-duration">{formatDurationMs(clip.durationMs)}</span> : null}
                      </div>
                      <strong>{clip.title || "Untitled clip"}</strong>
                    </button>
                    <span className="badge">{clip.kind === "render" ? "Rendered Copy" : "Original"}</span>
                    <div className="clip-card-actions">
                      {permissions?.viewEdits ? (
                        <button
                          type="button"
                          className="btn sm"
                          onClick={() => {
                            setEditClip(clip);
                            setPanel("edits");
                          }}
                        >
                          {permissions.createEdits ? "Edits" : "View Edits"}
                        </button>
                      ) : null}
                      {permissions?.removeClips ? (
                        <button
                          type="button"
                          className="btn sm"
                          onClick={() => {
                            if (!token) return;
                            if (!window.confirm("Remove this clip from the folder? The original stays in the owner's library.")) return;
                            void removeFolderClip(token, folderId, clip.id).then(() => load());
                          }}
                        >
                          Remove from Folder
                        </button>
                      ) : null}
                    </div>
                  </article>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {panel === "share" && folder && token ? (
        <SharePanel
          token={token}
          folder={folder}
          onClose={() => setPanel(null)}
          onRefresh={async (next) => {
            if (next) setFolder(next);
            else await load();
          }}
          onNotice={setNotice}
          onError={setError}
        />
      ) : null}
      {panel === "add" && folder && token ? (
        <AddClipsPanel
          token={token}
          folder={folder}
          busy={busy}
          onBusy={setBusy}
          onClose={() => setPanel(null)}
          onAdded={setFolder}
          onError={setError}
        />
      ) : null}
      {panel === "edits" && folder && token && editClip ? (
        <EditsPanel
          token={token}
          folder={folder}
          clip={editClip}
          onClose={() => {
            setPanel(null);
            setEditClip(null);
          }}
          onError={setError}
          onNotice={setNotice}
          onRefresh={load}
        />
      ) : null}
      {panel === "activity" && token ? (
        <ActivityPanel token={token} folderId={folderId} onClose={() => setPanel(null)} />
      ) : null}
    </main>
  );
}

function SharePanel({
  token,
  folder,
  onClose,
  onRefresh,
  onNotice,
  onError,
}: {
  token: string;
  folder: FolderDetail;
  onClose: () => void;
  onRefresh: (folder?: FolderDetail) => Promise<void>;
  onNotice: (value: string | null) => void;
  onError: (value: string | null) => void;
}) {
  const [owner, setOwner] = useState<SocialUser | null>(null);
  const [members, setMembers] = useState<FolderMember[]>([]);
  const [invites, setInvites] = useState<FolderInvite[]>([]);
  const [inviteRoles, setInviteRoles] = useState<FolderMemberRole[]>([]);
  const [publicShare, setPublicShare] = useState<FolderPublicShare | null>(folder.publicShare ?? null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SocialUser[]>([]);
  const [picked, setPicked] = useState<SocialUser | null>(null);
  const [role, setRole] = useState<FolderMemberRole>("viewer");
  const [target, setTarget] = useState<FolderMember | null>(null);

  useEffect(() => {
    void listFolderMembers(token, folder.id).then((people) => {
      setOwner(people.owner);
      setMembers(people.members);
      setInviteRoles(people.inviteRoles);
      if (people.inviteRoles[0]) setRole(people.inviteRoles[0]);
    });
    if (folder.permissions.manageMembers) {
      void listFolderInvites(token, folder.id).then(setInvites);
    }
  }, [folder.id, folder.permissions.manageMembers, token]);

  useEffect(() => {
    if (query.trim().length < 2) {
      setResults([]);
      return;
    }
    const timer = window.setTimeout(() => {
      void searchUsers(token, query).then(setResults);
    }, 200);
    return () => window.clearTimeout(timer);
  }, [query, token]);

  return (
    <div className="folder-modal" role="dialog" aria-label="Share folder">
      <button type="button" className="folder-modal-backdrop" aria-label="Close" onClick={onClose} />
      <section className="folder-modal-sheet">
        <h2>Share</h2>
        <h3>General access</h3>
        {folder.permissions.managePublicShare ? (
          <>
            <label>
              <input
                type="radio"
                checked={!publicShare?.enabled}
                onChange={() => {
                  void disableFolderPublicLink(token, folder.id).then(setPublicShare);
                }}
              />{" "}
              Private
            </label>
            <label>
              <input
                type="radio"
                checked={Boolean(publicShare?.enabled)}
                onChange={() => {
                  void enableFolderPublicLink(token, folder.id).then(setPublicShare);
                }}
              />{" "}
              Public link
            </label>
            {publicShare?.enabled ? (
              <div className="stack">
                {publicShare.url ? <code>{publicShare.url.replace(/^https?:\/\//, "")}</code> : null}
                <div className="row">
                  <button
                    type="button"
                    className="btn sm primary"
                    onClick={() => {
                      if (publicShare.url) void navigator.clipboard.writeText(publicShare.url);
                    }}
                  >
                    Copy Link
                  </button>
                  <button
                    type="button"
                    className="btn sm"
                    onClick={() => {
                      if (window.confirm("The old link will stop working.")) {
                        void regenerateFolderPublicLink(token, folder.id).then(setPublicShare);
                      }
                    }}
                  >
                    Regenerate
                  </button>
                  <button type="button" className="btn sm" onClick={() => void disableFolderPublicLink(token, folder.id).then(setPublicShare)}>
                    Disable
                  </button>
                </div>
                <label>
                  <input
                    type="checkbox"
                    checked={publicShare.allowDownloads}
                    onChange={(event) => void updateFolderPublicDownloads(token, folder.id, event.target.checked).then(setPublicShare)}
                  />{" "}
                  Allow downloads
                </label>
              </div>
            ) : null}
          </>
        ) : (
          <p className="muted">{publicShare?.enabled ? "Anyone with the link can view this folder." : "Only people with access can view this folder."}</p>
        )}
        {owner ? (
          <p>
            Owner: <strong>{owner.displayName}</strong>
          </p>
        ) : null}
        {members.map((member) => (
          <div key={member.user.id} className="folder-member-row">
            <SocialAvatar name={member.user.displayName} avatarUrl={member.user.avatarUrl} size={28} />
            <strong>{member.user.displayName}</strong>
            {member.canChangeRole ? (
              <select
                value={member.role}
                onChange={(event) => {
                  void updateFolderMemberRole(token, folder.id, member.user.id, {
                    role: event.target.value as FolderMemberRole,
                  }).then((next) => {
                    setMembers((current) => current.map((item) => (item.user.id === next.user.id ? next : item)));
                  });
                }}
              >
                {member.allowedRoles.map((value) => (
                  <option key={value} value={value}>
                    {folderRoleLabel(value)}
                  </option>
                ))}
              </select>
            ) : (
              <span className="badge">{folderRoleLabel(member.role)}</span>
            )}
            {member.canRemove ? (
              <button
                type="button"
                className="btn sm"
                onClick={() => {
                  if (!window.confirm(`Remove ${member.user.displayName}? Clips stay where they are.`)) return;
                  void removeFolderMember(token, folder.id, member.user.id).then(() => {
                    setMembers((current) => current.filter((item) => item.user.id !== member.user.id));
                  });
                }}
              >
                Remove
              </button>
            ) : null}
          </div>
        ))}
        {invites.map((invite) => (
          <div key={invite.id} className="folder-member-row">
            <span>
              {invite.invitee.displayName} · {folderRoleLabel(invite.role)} pending
            </span>
            {invite.canRevoke ? (
              <button
                type="button"
                className="btn sm"
                onClick={() => {
                  void deleteFolderInvite(token, folder.id, invite.id).then(() => {
                    setInvites((current) => current.filter((item) => item.id !== invite.id));
                  });
                }}
              >
                Revoke
              </button>
            ) : null}
          </div>
        ))}
        {inviteRoles.length > 0 ? (
          <div className="stack">
            <h3>Invite people</h3>
            <input value={query} placeholder="Search Replayr users" onChange={(event) => setQuery(event.target.value)} />
            {results.map((user) => (
              <button key={user.id} type="button" className="btn sm" onClick={() => setPicked(user)}>
                {user.displayName}
              </button>
            ))}
            <select value={role} onChange={(event) => setRole(event.target.value as FolderMemberRole)}>
              {inviteRoles.map((value) => (
                <option key={value} value={value}>
                  {folderRoleLabel(value)}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn primary sm"
              disabled={!picked}
              onClick={() => {
                if (!picked) return;
                void createFolderInvite(token, folder.id, { userId: picked.id, role }).then((result) => {
                  if (result.invite) setInvites((current) => [result.invite!, ...current]);
                  setPicked(null);
                  setQuery("");
                });
              }}
            >
              Send invite
            </button>
          </div>
        ) : null}
        {folder.permissions.transferOwnership ? (
          <div className="stack">
            <h3>Ownership</h3>
            {!target ? (
              <>
                <p className="muted">Choose an active member. Pending invites cannot become owner.</p>
                {members.map((member) => (
                  <button key={member.user.id} type="button" className="btn sm" onClick={() => setTarget(member)}>
                    Transfer to {member.user.displayName}
                  </button>
                ))}
              </>
            ) : (
              <>
                <p>
                  {target.user.displayName} will become Owner. You will become Manager.
                </p>
                <button
                  type="button"
                  className="btn danger"
                  onClick={() => {
                    void transferFolderOwnership(token, folder.id, { userId: target.user.id })
                      .then((next) => {
                        onNotice("Ownership transferred. You are now a Manager.");
                        return onRefresh(next);
                      })
                      .catch((caught) => onError(caught instanceof Error ? caught.message : "Could not transfer ownership."));
                  }}
                >
                  Confirm transfer
                </button>
                <button type="button" className="btn" onClick={() => setTarget(null)}>
                  Back
                </button>
              </>
            )}
          </div>
        ) : null}
        <button type="button" className="btn" onClick={onClose}>
          Done
        </button>
      </section>
    </div>
  );
}

function AddClipsPanel({
  token,
  folder,
  busy,
  onBusy,
  onClose,
  onAdded,
  onError,
}: {
  token: string;
  folder: FolderDetail;
  busy: boolean;
  onBusy: (value: boolean) => void;
  onClose: () => void;
  onAdded: (folder: FolderDetail) => void;
  onError: (value: string | null) => void;
}) {
  const [clips, setClips] = useState<ManagedClip[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const existing = new Set(folder.clips.map((clip) => clip.id));

  useEffect(() => {
    void fetchLibrary(token, { page: 1, limit: 80 }).then((page) => {
      setClips(page.clips.filter((clip) => clip.status === "ready" && !existing.has(clip.id)));
    });
  }, [token, folder.id]);

  return (
    <div className="folder-modal" role="dialog" aria-label="Add clips">
      <button type="button" className="folder-modal-backdrop" aria-label="Close" onClick={onClose} />
      <section className="folder-modal-sheet">
        <h2>Add clips</h2>
        <p className="muted">Only your ready cloud clips. This does not copy files.</p>
        {clips.length === 0 ? <p className="muted">No other cloud clips to add.</p> : null}
        <ul className="folder-clip-pick">
          {clips.map((clip) => (
            <li key={clip.id}>
              <label>
                <input
                  type="checkbox"
                  checked={selected.includes(clip.id)}
                  onChange={() =>
                    setSelected((current) =>
                      current.includes(clip.id) ? current.filter((id) => id !== clip.id) : [...current, clip.id],
                    )
                  }
                />{" "}
                {clip.title || "Untitled clip"}
              </label>
            </li>
          ))}
        </ul>
        <div className="row">
          <button
            type="button"
            className="btn primary"
            disabled={busy || selected.length === 0}
            onClick={() => {
              onBusy(true);
              void addFolderClips(token, folder.id, { clipIds: selected })
                .then((next) => {
                  onAdded(next);
                  onClose();
                })
                .catch((caught) => onError(caught instanceof Error ? caught.message : "Could not add those clips."))
                .finally(() => onBusy(false));
            }}
          >
            Add selected
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </section>
    </div>
  );
}

function EditsPanel({
  token,
  folder,
  clip,
  onClose,
  onError,
  onNotice,
  onRefresh,
}: {
  token: string;
  folder: FolderDetail;
  clip: FolderClip;
  onClose: () => void;
  onError: (value: string | null) => void;
  onNotice: (value: string | null) => void;
  onRefresh: () => Promise<void>;
}) {
  const [edits, setEdits] = useState<FolderEdit[]>([]);
  const [cloudClips, setCloudClips] = useState<ManagedClip[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const open = edits.find((item) => item.id === openId) ?? null;

  useEffect(() => {
    void listFolderEdits(token, folder.id, clip.id).then(setEdits);
    void fetchLibrary(token, { page: 1, limit: 50 }).then((page) => {
      setCloudClips(page.clips.filter((item) => item.status === "ready" && item.id !== clip.id));
    });
  }, [clip.id, folder.id, token]);

  async function handleConflict(caught: unknown) {
    if (isFolderEditConflict(caught)) {
      const choice = window.confirm("This edit was updated elsewhere. OK to reload the latest, or Cancel to duplicate as a new edit.");
      if (choice) {
        const latest = await listFolderEdits(token, folder.id, clip.id);
        setEdits(latest);
        return;
      }
      if (open) {
        const copy = await duplicateFolderEdit(token, folder.id, clip.id, open.id);
        setEdits((current) => [copy, ...current]);
        setOpenId(copy.id);
      }
      return;
    }
    onError(caught instanceof Error ? caught.message : "Could not save that edit.");
  }

  return (
    <div className="folder-modal" role="dialog" aria-label="Folder edits">
      <button type="button" className="folder-modal-backdrop" aria-label="Close" onClick={onClose} />
      <section className="folder-modal-sheet">
        <h2>Edits · {clip.title || "Untitled clip"}</h2>
        <p className="muted">These versions belong to the folder. The original clip is not overwritten.</p>
        {edits.map((edit) => (
          <div key={edit.id} className="folder-member-row">
            <div>
              <strong>{edit.name}</strong>
              <p className="muted">
                by {edit.createdBy.displayName} · {edit.renderedClipId ? "Has rendered copy" : "Draft"}
              </p>
            </div>
            <button type="button" className="btn sm" onClick={() => setOpenId(edit.id)}>
              {edit.canModify ? "Open" : "View"}
            </button>
            {folder.permissions.createEdits ? (
              <button
                type="button"
                className="btn sm"
                onClick={() => void duplicateFolderEdit(token, folder.id, clip.id, edit.id).then((copy) => setEdits((current) => [copy, ...current]))}
              >
                Duplicate
              </button>
            ) : null}
            {edit.canDelete ? (
              <button
                type="button"
                className="btn sm"
                onClick={() => {
                  if (!window.confirm("Delete this folder edit? Rendered copies already in the folder stay.")) return;
                  void deleteFolderEdit(token, folder.id, clip.id, edit.id).then(() => {
                    setEdits((current) => current.filter((item) => item.id !== edit.id));
                  });
                }}
              >
                Delete
              </button>
            ) : null}
          </div>
        ))}
        {folder.permissions.createEdits ? (
          <button
            type="button"
            className="btn primary sm"
            onClick={() => {
              void createFolderEdit(token, folder.id, clip.id, { name: "Untitled Edit" }).then((edit) => {
                setEdits((current) => [edit, ...current]);
                setOpenId(edit.id);
              });
            }}
          >
            New Edit
          </button>
        ) : null}
        {open ? (
          <div className="stack">
            <h3>{open.name}</h3>
            {open.canModify ? (
              <label>
                Name
                <input
                  defaultValue={open.name}
                  onBlur={(event) => {
                    const name = event.target.value.trim();
                    if (!name || name === open.name) return;
                    void updateFolderEdit(token, folder.id, clip.id, open.id, {
                      expectedRevision: open.revision,
                      name,
                    })
                      .then((next) => setEdits((current) => current.map((item) => (item.id === next.id ? next : item))))
                      .catch(handleConflict);
                  }}
                />
              </label>
            ) : null}
            {open.canRender ? (
              <label>
                Attach a rendered copy you own
                <select
                  defaultValue=""
                  onChange={(event) => {
                    const clipId = event.target.value;
                    if (!clipId) return;
                    void renderFolderEdit(token, folder.id, clip.id, open.id, { clipId })
                      .then(async (next) => {
                        setEdits((current) => current.map((item) => (item.id === next.id ? next : item)));
                        onNotice("Rendered copy added. The original is unchanged.");
                        await onRefresh();
                      })
                      .catch((caught) => onError(caught instanceof Error ? caught.message : "Could not attach that copy."));
                  }}
                >
                  <option value="">Choose a ready cloud clip</option>
                  {cloudClips.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.title || "Untitled clip"}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {open.canModify ? (
              <p className="muted">
                Web saves names and attached renders. Unsupported desktop fields stay on the document.
              </p>
            ) : null}
          </div>
        ) : null}
        <button type="button" className="btn" onClick={onClose}>
          Done
        </button>
      </section>
    </div>
  );
}

function ActivityPanel({ token, folderId, onClose }: { token: string; folderId: string; onClose: () => void }) {
  const [items, setItems] = useState<FolderActivity[]>([]);
  useEffect(() => {
    void listFolderActivity(token, folderId).then(setItems);
  }, [folderId, token]);
  return (
    <div className="folder-modal" role="dialog" aria-label="Folder activity">
      <button type="button" className="folder-modal-backdrop" aria-label="Close" onClick={onClose} />
      <section className="folder-modal-sheet">
        <h2>Activity</h2>
        {items.length === 0 ? <p className="muted">No folder activity yet.</p> : null}
        <ul className="folder-activity">
          {items.map((item) => (
            <li key={item.id}>
              <SocialAvatar name={item.actor.displayName} avatarUrl={item.actor.avatarUrl} size={24} />
              <span>
                {item.summary}
                <span className="muted"> · {new Date(item.createdAt).toLocaleString()}</span>
              </span>
            </li>
          ))}
        </ul>
        <button type="button" className="btn" onClick={onClose}>
          Done
        </button>
      </section>
    </div>
  );
}
