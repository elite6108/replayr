import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { AuthCard } from "../components/common/AuthCard";
import { ClipGrid } from "../components/common/ClipGrid";
import { PageHeader } from "../components/common/PageHeader";
import { AddClipsSheet } from "../components/library/AddClipsSheet";
import { FolderEditsSheet } from "../components/library/FolderEditsSheet";
import { FolderShareSheet } from "../components/library/FolderShareSheet";
import { LibraryTabs } from "../components/library/LibraryTabs";
import { folderAccessLabel, folderRoleLabel } from "../services/api.folders";
import type { FolderClip } from "../services/social-types";
import { useAuthStore } from "../stores/authStore";
import { useCloudStore } from "../stores/cloudStore";
import { useFolderStore } from "../stores/folderStore";
import type { CloudClip } from "../types/clip";
import { formatDuration } from "../utils/format";

function toCloudClip(clip: FolderClip): CloudClip {
  return {
    id: clip.id,
    title: clip.title,
    slug: clip.slug,
    status: clip.status,
    visibility: clip.visibility,
    durationMs: clip.durationMs,
    width: null,
    height: null,
    fileSizeBytes: null,
    createdAt: clip.createdAt,
  };
}

export function FolderPage() {
  const { folderId } = useParams();
  const navigate = useNavigate();
  const configured = useAuthStore((state) => state.configured);
  const user = useAuthStore((state) => state.user);
  const folder = useFolderStore((state) => state.activeFolder);
  const loading = useFolderStore((state) => state.detailLoading);
  const error = useFolderStore((state) => state.error);
  const open = useFolderStore((state) => state.open);
  const close = useFolderStore((state) => state.close);
  const rename = useFolderStore((state) => state.rename);
  const remove = useFolderStore((state) => state.remove);
  const addClips = useFolderStore((state) => state.addClips);
  const removeClip = useFolderStore((state) => state.removeClip);
  const playClip = useFolderStore((state) => state.playClip);
  const leave = useFolderStore((state) => state.leave);
  const playRemote = useCloudStore((state) => state.playRemote);
  const [adding, setAdding] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [editingClip, setEditingClip] = useState<FolderClip | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    if (folderId && user) void open(folderId);
    return () => close();
  }, [close, folderId, open, user]);

  async function play(clip: FolderClip) {
    if (!folder) return;
    const url = await playClip(folder.id, clip.id);
    if (url) await playRemote(toCloudClip(clip), url);
  }

  async function deleteFolder() {
    if (!folder) return;
    if (
      !window.confirm(
        `Delete “${folder.name}”? Clips stay in your library. This only removes the folder.`,
      )
    ) {
      return;
    }
    try {
      await remove(folder.id);
      navigate("/library/folders");
    } catch {
      /* toast handled by store */
    }
  }

  async function leaveFolder() {
    if (!folder) return;
    if (!window.confirm(`Leave “${folder.name}”? You will lose access until invited again.`)) return;
    const left = await leave(folder.id);
    if (left) navigate("/library/folders");
  }

  function commitRename() {
    if (!folder) return;
    const name = draft.trim();
    setRenaming(false);
    if (name && name !== folder.name) void rename(folder.id, name);
  }

  const permissions = folder?.permissions;
  const accessBadge = folder ? folderAccessLabel(folder) : "Private";
  const roleBadge =
    folder && folder.role !== "owner" && folder.role !== "public" ? folderRoleLabel(folder.role) : null;

  return (
    <>
      <PageHeader title="Library" subtitle="Folders organize cloud clips. They are not folders on this PC.">
        <LibraryTabs />
      </PageHeader>
      {!configured ? (
        <section className="panel">
          <p>Sign-in is not configured on this build.</p>
        </section>
      ) : !user ? (
        <AuthCard />
      ) : loading && !folder ? (
        <p className="muted">Loading folder…</p>
      ) : error && !folder ? (
        <section className="panel stack">
          <div className="error-text">{error}</div>
          <Link className="btn" to="/library/folders">
            Back to folders
          </Link>
        </section>
      ) : folder ? (
        <div className="stack">
          <section className="panel stack">
            <p className="muted">
              <Link to="/library/folders">Folders</Link>
              <span aria-hidden="true"> / </span>
              {folder.name}
            </p>
            {renaming ? (
              <input
                className="clip-rename"
                value={draft}
                autoFocus
                aria-label="Folder name"
                onChange={(event) => setDraft(event.target.value)}
                onBlur={commitRename}
                onKeyDown={(event) => {
                  if (event.key === "Enter") commitRename();
                  if (event.key === "Escape") setRenaming(false);
                }}
              />
            ) : (
              <div className="panel-head">
                <h2>{folder.name}</h2>
                <span className="badge">{accessBadge}</span>
                {roleBadge ? <span className="badge">{roleBadge}</span> : null}
              </div>
            )}
            {folder.description ? <p className="muted">{folder.description}</p> : null}
            <p className="muted">
              {folder.clipCount === 1 ? "1 clip" : `${folder.clipCount} clips`}
              {folder.owner ? ` · ${folder.owner.displayName}` : " · Your clips stay yours"}
            </p>
            <div className="row">
              {permissions?.addClips ? (
                <button type="button" className="btn primary" onClick={() => setAdding(true)}>
                  + Add Clips
                </button>
              ) : null}
              <button type="button" className="btn" onClick={() => setSharing(true)}>
                Share
              </button>
              {permissions?.manageFolder ? (
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setDraft(folder.name);
                    setRenaming(true);
                  }}
                >
                  Rename
                </button>
              ) : null}
              {permissions?.deleteFolder ? (
                <button type="button" className="btn danger" onClick={() => void deleteFolder()}>
                  Delete folder
                </button>
              ) : null}
              {folder.role !== "owner" ? (
                <button type="button" className="btn" onClick={() => void leaveFolder()}>
                  Leave folder
                </button>
              ) : null}
            </div>
          </section>
          {folder.clips.length === 0 ? (
            <ClipGrid title="Empty folder" body="Add cloud clips. Removing them later does not delete the originals." />
          ) : (
            <section className="panel flush">
              <div className="clip-grid">
                {folder.clips.map((clip) => (
                  <article key={clip.id} className="clip-card live folder-clip-card">
                    <button
                      type="button"
                      className="clip-open"
                      disabled={clip.status !== "ready"}
                      onClick={() => void play(clip)}
                    >
                      <div className="clip-thumb">
                        {clip.thumbnailUrl ? <img src={clip.thumbnailUrl} alt="" /> : null}
                        {clip.durationMs ? <span className="clip-duration">{formatDuration(clip.durationMs)}</span> : null}
                      </div>
                    </button>
                    <div className="clip-meta">
                      <strong>{clip.title || "Untitled clip"}</strong>
                      <span className="badge">{clip.kind === "render" ? "Rendered Copy" : "Original"}</span>
                      <div className="row">
                        {permissions?.viewEdits ? (
                          <button type="button" className="btn sm" onClick={() => setEditingClip(clip)}>
                            {permissions.createEdits ? "Open in Editor" : "View Edits"}
                          </button>
                        ) : null}
                        {permissions?.removeClips ? (
                          <button
                            type="button"
                            className="btn sm"
                            onClick={() => {
                              if (
                                window.confirm(
                                  "Remove this clip from the folder? The original clip stays in the owner's library.",
                                )
                              ) {
                                void removeClip(folder.id, clip.id);
                              }
                            }}
                          >
                            Remove from folder
                          </button>
                        ) : null}
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          )}
        </div>
      ) : null}
      {adding && folder && permissions?.addClips ? (
        <AddClipsSheet
          existingIds={folder.clips.map((clip) => clip.id)}
          onAdd={(clipIds) => addClips(folder.id, clipIds)}
          onClose={() => setAdding(false)}
        />
      ) : null}
      {sharing && folder ? <FolderShareSheet folderId={folder.id} onClose={() => setSharing(false)} /> : null}
      {editingClip && folder ? (
        <FolderEditsSheet
          folderId={folder.id}
          folderName={folder.name}
          clip={editingClip}
          onClose={() => setEditingClip(null)}
        />
      ) : null}
    </>
  );
}
