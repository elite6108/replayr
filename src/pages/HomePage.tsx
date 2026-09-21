import { Link, useNavigate } from "react-router-dom";
import { useEffect, useMemo, useState } from "react";
import { ClipCard } from "../components/common/ClipCard";
import { ClipGrid } from "../components/common/ClipGrid";
import { ClipRail } from "../components/common/ClipRail";
import { DeleteClipDialog, type DeleteClipScope } from "../components/common/DeleteClipDialog";
import { GameProfilesCard } from "../components/home/GameProfilesCard";
import { HeroCapturePanel } from "../components/home/HeroCapturePanel";
import { HomePeopleSearch } from "../components/home/HomePeopleSearch";
import { LastSessionCard } from "../components/home/LastSessionCard";
import { fetchPublicFeed } from "../services/social";
import type { PublicFeedClip } from "../services/social";
import { useAuthStore } from "../stores/authStore";
import { useLibraryStore } from "../stores/libraryStore";
import { formatCount, formatHandle } from "../utils/format";

export function HomePage() {
  const navigate = useNavigate();
  const user = useAuthStore((state) => state.user);
  const clips = useLibraryStore((state) => state.clips);
  const play = useLibraryStore((state) => state.play);
  const favorite = useLibraryStore((state) => state.favorite);
  const upload = useLibraryStore((state) => state.upload);
  const rename = useLibraryStore((state) => state.rename);
  const removeBoth = useLibraryStore((state) => state.remove);
  const removeLocalOnly = useLibraryStore((state) => state.removeLocal);
  const download = useLibraryStore((state) => state.download);
  const copyLink = useLibraryStore((state) => state.copyLink);
  const removeFromCloud = useLibraryStore((state) => state.removeFromCloud);
  const toggleSelect = useLibraryStore((state) => state.toggleSelect);
  const selected = useLibraryStore((state) => state.selectedIds);
  const token = useAuthStore((state) => state.session?.access_token);
  const [feed, setFeed] = useState<PublicFeedClip[]>([]);
  const [pendingDelete, setPendingDelete] = useState<{ localId: string; hasCloud: boolean } | null>(null);
  const [momentFilter, setMomentFilter] = useState<"all" | "favorites">("all");

  const recentClips = useMemo(() => {
    const pool = momentFilter === "favorites" ? clips.filter((clip) => clip.favorite) : clips;
    return pool.slice(0, 8);
  }, [clips, momentFilter]);

  useEffect(() => {
    void fetchPublicFeed(token)
      .then(setFeed)
      .catch(() => undefined);
  }, [token]);

  return (
    <div className="home-command">
      <header className="home-page-head">
        <div>
          <h1>Home</h1>
          <p className="muted">Your game. Your moments. All here.</p>
        </div>
        {user ? <HomePeopleSearch /> : null}
      </header>

      <HeroCapturePanel />

      {clips.length === 0 ? (
        <section className="panel">
          <ClipGrid title="Your first clip lands here" body="Save an Instant Replay or start a full recording. Finished files stay on this PC." />
        </section>
      ) : (
        <section className="panel flush home-moments">
          <div className="panel-head home-moments-head">
            <h2>Recent moments</h2>
            <div className="home-moments-tools">
              <div className="home-filter">
                <button type="button" className={momentFilter === "all" ? "active" : ""} onClick={() => setMomentFilter("all")}>
                  All moments
                </button>
                <button type="button" className={momentFilter === "favorites" ? "active" : ""} onClick={() => setMomentFilter("favorites")}>
                  Favorites
                </button>
              </div>
              <Link className="home-moments-link" to="/library">
                {selected.length > 0 ? `${selected.length} selected · View Library` : "View Library →"}
              </Link>
            </div>
          </div>
          {recentClips.length === 0 ? (
            <p className="muted home-moments-empty">No favorites yet.</p>
          ) : (
            <div className="clip-rail-track">
              {recentClips.map((clip) => (
                <ClipCard
                  key={clip.localId}
                  clip={clip}
                  selected={selected.includes(clip.localId)}
                  onPlay={(item) => play(item.localId)}
                  onFavorite={(item) => void favorite(item.localId, !item.favorite)}
                  onUpload={user ? (item) => void upload(item.localId) : undefined}
                  onSelect={(item) => toggleSelect(item.localId)}
                  onRename={(item, title) => void rename(item.localId, title)}
                  onDelete={(item) => setPendingDelete({ localId: item.localId, hasCloud: Boolean(item.cloudClipId) })}
                  onRemoveFromCloud={(item) => {
                    if (
                      window.confirm(
                        "Remove this cloud copy? The file on this PC stays. The share link will stop working.",
                      )
                    ) {
                      void removeFromCloud(item.localId);
                    }
                  }}
                  onDownload={(item) => void download(item.localId)}
                  onCopyLink={(item) => void copyLink(item.localId)}
                  onEdit={(item) => navigate(`/editor/${item.localId}`)}
                />
              ))}
            </div>
          )}
        </section>
      )}

      <div className="home-lower">
        <LastSessionCard clip={clips[0] ?? null} />
        <GameProfilesCard />
      </div>

      {feed.length > 0 ? (
        <ClipRail
          title="For You"
          action={
            <Link className="btn ghost" to="/explore">
              See all
            </Link>
          }
        >
          {feed.slice(0, 8).map((clip) => (
            <Link key={clip.id} className="feed-home-card" to="/explore">
              {clip.thumbnailUrl ? <img src={clip.thumbnailUrl} alt="" loading="lazy" /> : <div className="feed-thumb-empty" />}
              <strong>{clip.title || "Untitled clip"}</strong>
              <span className="muted">
                {formatHandle(clip.author)} · {formatCount(clip.likeCount)} likes
              </span>
            </Link>
          ))}
        </ClipRail>
      ) : null}
      {pendingDelete ? (
        <DeleteClipDialog
          showPc
          showCloud={pendingDelete.hasCloud}
          showBoth={pendingDelete.hasCloud}
          onClose={() => setPendingDelete(null)}
          onChoose={(scope: DeleteClipScope) => {
            const { localId } = pendingDelete;
            setPendingDelete(null);
            if (scope === "pc") void removeLocalOnly(localId);
            else if (scope === "cloud") void removeFromCloud(localId);
            else void removeBoth(localId);
          }}
        />
      ) : null}
    </div>
  );
}
