import { useEffect, useState } from "react";
import { listFolderActivity } from "../../services/api.folders";
import type { FolderActivity } from "../../services/social-types";
import { useAuthStore } from "../../stores/authStore";

export function FolderActivitySheet({ folderId, onClose }: { folderId: string; onClose: () => void }) {
  const token = useAuthStore((state) => state.session?.access_token);
  const [items, setItems] = useState<FolderActivity[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    void listFolderActivity(token, folderId)
      .then(setItems)
      .catch((caught) => setError(caught instanceof Error ? caught.message : "Could not load folder activity."));
  }, [folderId, token]);

  return (
    <div className="send-overlay" role="dialog" aria-modal="true" aria-label="Folder activity">
      <button type="button" className="player-backdrop" aria-label="Close" onClick={onClose} />
      <section className="send-sheet folder-share-sheet">
        <h2>Activity</h2>
        <p className="muted">Only people with access see this. Autosaves are not listed.</p>
        {error ? <p className="error-text">{error}</p> : null}
        {items.length === 0 && !error ? <p className="muted">No folder activity yet.</p> : null}
        <ul className="folder-share-list">
          {items.map((item) => (
            <li key={item.id} className="folder-edit-row">
              <strong>{item.summary}</strong>
              <span className="muted">{new Date(item.createdAt).toLocaleString()}</span>
            </li>
          ))}
        </ul>
        <div className="row">
          <button type="button" className="btn" onClick={onClose}>
            Done
          </button>
        </div>
      </section>
    </div>
  );
}
