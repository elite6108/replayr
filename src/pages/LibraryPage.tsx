import { NavLink } from "react-router-dom";
import { useEffect, useMemo } from "react";
import { AuthCard } from "../components/common/AuthCard";
import { ClipCard } from "../components/common/ClipCard";
import { ClipGrid } from "../components/common/ClipGrid";
import { CloudClipCard } from "../components/common/CloudClipCard";
import { PageHeader } from "../components/common/PageHeader";
import { SelectionBar } from "../components/common/SelectionBar";
import { useAuthStore } from "../stores/authStore";
import { useCloudStore } from "../stores/cloudStore";
import { useLibraryStore } from "../stores/libraryStore";
import { formatBytes } from "../utils/format";

export function LibraryPage({ view = "local" }: { view?: "local" | "cloud" }) {
  const clips = useLibraryStore((state) => state.clips);
  const localError = useLibraryStore((state) => state.error);
  const refreshLocal = useLibraryStore((state) => state.refresh);
  const favoritesOnly = useLibraryStore((state) => state.favoritesOnly);
  const setFavoritesOnly = useLibraryStore((state) => state.setFavoritesOnly);
  const play = useLibraryStore((state) => state.play);
  const favorite = useLibraryStore((state) => state.favorite);
  const upload = useLibraryStore((state) => state.upload);
  const renameLocal = useLibraryStore((state) => state.rename);
  const removeLocal = useLibraryStore((state) => state.remove);
  const removeLocalMany = useLibraryStore((state) => state.removeMany);
  const removeLocalFromCloud = useLibraryStore((state) => state.removeFromCloud);
  const removeLocalFromCloudMany = useLibraryStore((state) => state.removeFromCloudMany);
  const downloadLocal = useLibraryStore((state) => state.download);
  const downloadLocalMany = useLibraryStore((state) => state.downloadMany);
  const copyLocalLink = useLibraryStore((state) => state.copyLink);
  const toggleLocalSelect = useLibraryStore((state) => state.toggleSelect);
  const selectAllLocal = useLibraryStore((state) => state.selectAll);
  const clearLocalSelection = useLibraryStore((state) => state.clearSelection);
  const selectedLocal = useLibraryStore((state) => state.selectedIds);
  const configured = useAuthStore((state) => state.configured);
  const user = useAuthStore((state) => state.user);
  const storage = useAuthStore((state) => state.storage);
  const cloudClips = useCloudStore((state) => state.clips);
  const cloudError = useCloudStore((state) => state.error);
  const cloudLoading = useCloudStore((state) => state.loading);
  const refreshCloud = useCloudStore((state) => state.refresh);
  const removeCloud = useCloudStore((state) => state.remove);
  const removeCloudMany = useCloudStore((state) => state.removeMany);
  const renameCloud = useCloudStore((state) => state.rename);
  const downloadCloud = useCloudStore((state) => state.download);
  const downloadCloudMany = useCloudStore((state) => state.downloadMany);
  const copyCloudLink = useCloudStore((state) => state.copyLink);
  const toggleCloudSelect = useCloudStore((state) => state.toggleSelect);
  const selectAllCloud = useCloudStore((state) => state.selectAll);
  const clearCloudSelection = useCloudStore((state) => state.clearSelection);
  const selectedCloud = useCloudStore((state) => state.selectedIds);
  const visible = useMemo(
    () => (favoritesOnly ? clips.filter((clip) => clip.favorite) : clips),
    [clips, favoritesOnly],
  );
  const used = storage?.storage_used_bytes ?? 0;
  const limit = storage?.storage_limit_bytes ?? 0;
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  const selectedLocalClips = visible.filter((clip) => selectedLocal.includes(clip.localId));
  const selectedCloudLinked = selectedLocalClips.filter((clip) => clip.cloudClipId).length;
  const userId = user?.id;

  useEffect(() => {
    void refreshLocal();
    if (userId) void refreshCloud();
  }, [refreshCloud, refreshLocal, userId]);

  return (
    <>
      <PageHeader
        title="Library"
        subtitle="This PC and cloud copies stay separate. Select clips to download or delete more than one."
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
        <>
          {localError ? <div className="error-text">{localError}</div> : null}
          {visible.length === 0 ? (
          <ClipGrid
            title={favoritesOnly ? "No favorites yet" : "Nothing saved yet"}
            body={
              favoritesOnly
                ? "Star a clip from the library or player to keep it here."
                : "Save an Instant Replay or stop a recording. Cloud copies from other PCs are under Cloud."
            }
          />
        ) : (
          <section className="panel flush">
            <div className="panel-head">
              <h2>On this PC</h2>
              <span className="badge">{visible.length}</span>
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
                    if (window.confirm("Delete this clip from this PC and the cloud?")) void removeLocal(item.localId);
                  }}
                  onRemoveFromCloud={(item) => {
                    if (
                      window.confirm(
                        "Remove this cloud copy? The file on this PC stays. The share link will stop working.",
                      )
                    ) {
                      void removeLocalFromCloud(item.localId);
                    }
                  }}
                  onDownload={(item) => void downloadLocal(item.localId)}
                  onCopyLink={(item) => void copyLocalLink(item.localId)}
                />
              ))}
            </div>
            <SelectionBar
              count={selectedLocalClips.length}
              onClear={clearLocalSelection}
              onSelectAll={() => selectAllLocal(visible.map((clip) => clip.localId))}
            >
              <button type="button" className="btn" onClick={() => void downloadLocalMany(selectedLocalClips.map((clip) => clip.localId))}>
                Download
              </button>
              {selectedCloudLinked > 0 ? (
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    if (
                      window.confirm(
                        `Remove ${selectedCloudLinked} cloud ${selectedCloudLinked === 1 ? "copy" : "copies"}? Files on this PC stay.`,
                      )
                    ) {
                      void removeLocalFromCloudMany(selectedLocalClips.map((clip) => clip.localId));
                    }
                  }}
                >
                  Remove from cloud
                </button>
              ) : null}
              <button
                type="button"
                className="btn danger"
                onClick={() => {
                  if (
                    window.confirm(
                      `Delete ${selectedLocalClips.length} clip${selectedLocalClips.length === 1 ? "" : "s"} from this PC and the cloud?`,
                    )
                  ) {
                    void removeLocalMany(selectedLocalClips.map((clip) => clip.localId));
                  }
                }}
              >
                Delete
              </button>
            </SelectionBar>
          </section>
          )}
        </>
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
              <SelectionBar
                count={selectedCloud.length}
                onClear={clearCloudSelection}
                onSelectAll={() => selectAllCloud(cloudClips.map((clip) => clip.id))}
              >
                <button type="button" className="btn" onClick={() => void downloadCloudMany(selectedCloud)}>
                  Download
                </button>
                <button
                  type="button"
                  className="btn danger"
                  onClick={() => {
                    if (
                      window.confirm(
                        `Delete ${selectedCloud.length} clip${selectedCloud.length === 1 ? "" : "s"} from this PC and the cloud?`,
                      )
                    ) {
                      void removeCloudMany(selectedCloud);
                    }
                  }}
                >
                  Delete
                </button>
              </SelectionBar>
            </section>
          )}
        </div>
      )}
    </>
  );
}
