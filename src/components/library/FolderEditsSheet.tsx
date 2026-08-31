import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { FolderClip, FolderEdit, FolderEditDocument } from "../../services/social-types";
import { useEditorContextStore } from "../../stores/editorContextStore";
import { useFolderStore } from "../../stores/folderStore";
import { useLibraryStore } from "../../stores/libraryStore";
function formatUpdated(value: string): string {
  const ms = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(ms) || ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return new Date(value).toLocaleDateString();
}

function emptyDocument(): FolderEditDocument {
  return { version: 1 };
}

export function FolderEditsSheet({
  folderId,
  folderName,
  clip,
  onClose,
}: {
  folderId: string;
  folderName: string;
  clip: FolderClip;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const folder = useFolderStore((state) => state.activeFolder);
  const edits = useFolderStore((state) => state.editsByClip[clip.id] ?? []);
  const loading = useFolderStore((state) => state.editsLoading);
  const loadEdits = useFolderStore((state) => state.loadEdits);
  const createEdit = useFolderStore((state) => state.createEdit);
  const removeEdit = useFolderStore((state) => state.removeEdit);
  const duplicateEdit = useFolderStore((state) => state.duplicateEdit);
  const saveEdit = useFolderStore((state) => state.saveEdit);
  const playClip = useFolderStore((state) => state.playClip);
  const setFolderEdit = useEditorContextStore((state) => state.setFolderEdit);
  const localClips = useLibraryStore((state) => state.clips);
  const [busy, setBusy] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const canCreate = Boolean(folder?.permissions.createEdits);

  useEffect(() => {
    void loadEdits(folderId, clip.id);
  }, [clip.id, folderId, loadEdits]);

  async function openEdit(edit: FolderEdit) {
    if (!folder) return;
    setBusy(true);
    const playbackUrl = await playClip(folderId, clip.id);
    setBusy(false);
    if (!playbackUrl) return;
    const localId = localClips.find((item) => item.cloudClipId === clip.id)?.localId ?? null;
    setFolderEdit({
      kind: "folderEdit",
      folderId,
      folderName,
      sourceClipId: clip.id,
      sourceTitle: clip.title || "Untitled clip",
      editId: edit.id,
      editName: edit.name,
      revision: edit.revision,
      permissions: folder.permissions,
      playbackUrl,
      localId,
      editData: edit.editData ?? emptyDocument(),
    });
    onClose();
    navigate(`/editor/folder/${folderId}/${edit.id}`);
  }

  async function makeEdit() {
    if (!canCreate || busy) return;
    setBusy(true);
    const edit = await createEdit(folderId, clip.id, { name: "Untitled Edit", editData: emptyDocument() });
    setBusy(false);
    if (edit) await openEdit(edit);
  }

  return (
    <div className="send-overlay" role="dialog" aria-modal="true" aria-label="Folder edits">
      <button type="button" className="player-backdrop" aria-label="Close" onClick={onClose} />
      <section className="send-sheet folder-share-sheet">
        <h2>Edits</h2>
        <p className="muted">
          {clip.title || "Untitled clip"} · Original stays untouched. These versions belong to the folder.
        </p>
        {loading && edits.length === 0 ? <p className="muted">Loading edits…</p> : null}
        {edits.length === 0 && !loading ? <p className="muted">No folder edits yet.</p> : null}
        <ul className="folder-share-list">
          {edits.map((edit) => (
            <li key={edit.id} className="folder-edit-row">
              <div className="folder-edit-main">
                {renamingId === edit.id ? (
                  <input
                    className="clip-rename"
                    value={draft}
                    autoFocus
                    aria-label="Edit name"
                    onChange={(event) => setDraft(event.target.value)}
                    onBlur={() => {
                      const name = draft.trim();
                      setRenamingId(null);
                      if (name && name !== edit.name) {
                        void saveEdit(folderId, clip.id, edit.id, {
                          expectedRevision: edit.revision,
                          name,
                        });
                      }
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") event.currentTarget.blur();
                      if (event.key === "Escape") setRenamingId(null);
                    }}
                  />
                ) : (
                  <strong>{edit.name}</strong>
                )}
                <span className="muted">
                  by {edit.createdBy.displayName} · Updated {formatUpdated(edit.updatedAt)}
                </span>
              </div>
              <div className="row">
                {folder?.permissions.modifyEdits ? (
                  <button type="button" className="btn sm" onClick={() => void openEdit(edit)}>
                    Open in Editor
                  </button>
                ) : (
                  <button type="button" className="btn sm" onClick={() => void openEdit(edit)} disabled={!edit.renderedClipId}>
                    Preview
                  </button>
                )}
                {canCreate ? (
                  <button type="button" className="btn sm" disabled={busy} onClick={() => void duplicateEdit(folderId, clip.id, edit.id)}>
                    Duplicate
                  </button>
                ) : null}
                {edit.canModify ? (
                  <button
                    type="button"
                    className="btn sm"
                    onClick={() => {
                      setDraft(edit.name);
                      setRenamingId(edit.id);
                    }}
                  >
                    Rename
                  </button>
                ) : null}
                {edit.canDelete ? (
                  <button
                    type="button"
                    className="btn sm"
                    onClick={() => {
                      if (window.confirm("Delete this folder edit? The original clip stays. Rendered copies already in the folder stay too.")) {
                        void removeEdit(folderId, clip.id, edit.id);
                      }
                    }}
                  >
                    Delete
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
        <div className="row">
          {canCreate ? (
            <button type="button" className="btn primary" disabled={busy} onClick={() => void makeEdit()}>
              {busy ? "Working…" : "New Edit"}
            </button>
          ) : null}
          <button type="button" className="btn" onClick={onClose}>
            Done
          </button>
        </div>
      </section>
    </div>
  );
}
