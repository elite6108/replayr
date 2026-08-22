import { NavLink } from "react-router-dom";
import { useMemo } from "react";
import { AuthCard } from "../components/common/AuthCard";
import { ClipCard } from "../components/common/ClipCard";
import { ClipGrid } from "../components/common/ClipGrid";
import { CloudClipCard } from "../components/common/CloudClipCard";
import { PageHeader } from "../components/common/PageHeader";
import { useAuthStore } from "../stores/authStore";
import { useCloudStore } from "../stores/cloudStore";
import { useLibraryStore } from "../stores/libraryStore";
import { formatBytes } from "../utils/format";

export function LibraryPage({ view = "local" }: { view?: "local" | "cloud" }) {
  const clips = useLibraryStore((state) => state.clips);
  const favoritesOnly = useLibraryStore((state) => state.favoritesOnly);
  const setFavoritesOnly = useLibraryStore((state) => state.setFavoritesOnly);
  const play = useLibraryStore((state) => state.play);
  const favorite = useLibraryStore((state) => state.favorite);
  const upload = useLibraryStore((state) => state.upload);
  const renameLocal = useLibraryStore((state) => state.rename);
  const removeLocal = useLibraryStore((state) => state.remove);
  const downloadLocal = useLibraryStore((state) => state.download);
  const copyLocalLink = useLibraryStore((state) => state.copyLink);
  const toggleLocalSelect = useLibraryStore((state) => state.toggleSelect);
  const clearLocalSelection = useLibraryStore((state) => state.clearSelection);
  const selectedLocal = useLibraryStore((state) => state.selectedIds);
  const configured = useAuthStore((state) => state.configured);
  const user = useAuthStore((state) => state.user);
  const storage = useAuthStore((state) => state.storage);
  const cloudClips = useCloudStore((state) => state.clips);
  const cloudError = useCloudStore((state) => state.error);
  const cloudLoading = useCloudStore((state) => state.loading);
  const removeCloud = useCloudStore((state) => state.remove);
  const renameCloud = useCloudStore((state) => state.rename);
  const downloadCloud = useCloudStore((state) => state.download);
  const copyCloudLink = useCloudStore((state) => state.copyLink);
  const toggleCloudSelect = useCloudStore((state) => state.toggleSelect);
  const clearCloudSelection = useCloudStore((state) => state.clearSelection);
  const selectedCloud = useCloudStore((state) => state.selectedIds);
  const visible = useMemo(
    () => (favoritesOnly ? clips.filter((clip) => clip.favorite) : clips),
    [clips, favoritesOnly],
  );
  const used = storage?.storage_used_bytes ?? 0;
  const limit = storage?.storage_limit_bytes ?? 0;
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;

  return (
    <>
      <PageHeader
        title="Library"
        subtitle="This PC and cloud copies stay separate. Right-click a clip to rename, download, or delete."
      >
        <nav className="tabs" aria-label="Library view">
          <NavLink to="/library" end className={({ isActive }) => (isActive ? "active" : undefined)}>
            This PC
          </NavLink>
          <NavLink to="/library/cloud" className={({ isActive }) => (isActive ? "active" : undefined)}>
            Cloud
          </NavLink>
        </nav>
        {view === "local" ? (
          <button
            type="button"
            className={`btn ${favoritesOnly ? "primary" : ""}`}
            onClick={() => setFavoritesOnly(!favoritesOnly)}
          >
            {favoritesOnly ? "All clips" : "Favorites"}
          </button>
        ) : null}
      </PageHeader>

      {view === "local" ? (
        visible.length === 0 ? (
          <ClipGrid
            title={favoritesOnly ? "No favorites yet" : "Nothing saved yet"}
            body={
              favoritesOnly
                ? "Star a clip from the library or player to keep it here."
                : "Save an Instant Replay or stop a recording. Finished files appear here."
            }
          />
        ) : (
          <section className="panel flush">
            <div className="panel-head">
              <h2>On this PC</h2>
              <span className="badge">{visible.length}</span>
              {selectedLocal.length > 0 ? (
                <button type="button" className="btn ghost" onClick={clearLocalSelection}>
                  {selectedLocal.length} selected
                </button>
              ) : null}
            </div>
            <div className="clip-grid">
              {visible.map((clip) => (
                <ClipCard
                  key={clip.localId}
                  clip={clip}
                  selected={selectedLocal.includes(clip.localId)}
                  onPlay={(item) => play(item.localId)}
                  onFavorite={(item) => void favorite(item.localId, !item.favorite)}
                  onUpload={user ? (item) => void upload(item.localId) : undefined}
                  onSelect={(item) => toggleLocalSelect(item.localId)}
                  onRename={(item, title) => void renameLocal(item.localId, title)}
                  onDelete={(item) => {
                    if (window.confirm("Delete this clip from this PC?")) void removeLocal(item.localId);
                  }}
                  onDownload={(item) => void downloadLocal(item.localId)}
                  onCopyLink={(item) => void copyLocalLink(item.localId)}
                />
              ))}
            </div>
          </section>
        )
      ) : !configured ? (
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
          {storage ? (
            <section className="panel">
              <div className="panel-head">
                <h2>Cloud storage</h2>
                <span className="badge">
                  {formatBytes(used)} / {formatBytes(limit)}
                </span>
              </div>
              <div className="meter" aria-label="Cloud storage used">
                <span style={{ width: `${pct}%` }} />
              </div>
            </section>
          ) : null}
          {cloudError ? <div className="error-text">{cloudError}</div> : null}
          {cloudLoading && cloudClips.length === 0 ? (
            <p className="muted">Loading cloud clips…</p>
          ) : cloudClips.length === 0 ? (
            <ClipGrid
              title="No cloud clips yet"
              body="Open a local clip and choose Upload, or turn on automatic upload in Settings. Bytes go to R2; this list is the metadata copy."
            />
          ) : (
            <section className="panel flush">
              <div className="panel-head">
                <h2>Uploaded</h2>
                <span className="badge">{cloudClips.length}</span>
                {selectedCloud.length > 0 ? (
                  <button type="button" className="btn ghost" onClick={clearCloudSelection}>
                    {selectedCloud.length} selected
                  </button>
                ) : null}
              </div>
              <div className="clip-grid">
                {cloudClips.map((clip) => (
                  <CloudClipCard
                    key={clip.id}
                    clip={clip}
                    selected={selectedCloud.includes(clip.id)}
                    onSelect={(item) => toggleCloudSelect(item.id)}
                    onRename={(item, title) => void renameCloud(item.id, title)}
                    onDelete={(item) => void removeCloud(item.id)}
                    onDownload={(item) => void downloadCloud(item.id)}
                    onCopyLink={(item) => void copyCloudLink(item.id)}
                  />
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </>
  );
}
