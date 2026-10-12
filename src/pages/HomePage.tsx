import { Link, useNavigate } from "react-router-dom";
import { useEffect, useMemo, useState } from "react";
import { ClipCard } from "../components/common/ClipCard";
import { ClipGrid } from "../components/common/ClipGrid";
import { DeleteClipDialog, type DeleteClipScope } from "../components/common/DeleteClipDialog";
import { GameProfilesCard } from "../components/home/GameProfilesCard";
import { HeroCapturePanel } from "../components/home/HeroCapturePanel";
import { LastSessionCard } from "../components/home/LastSessionCard";
import { useAuthStore } from "../stores/authStore";
import { useLibraryStore } from "../stores/libraryStore";
import { useScreenshotStore } from "../stores/screenshotStore";

function localDay(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value.slice(0, 10) : date.toDateString();
}

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
  const screenshots = useScreenshotStore((state) => state.items);
  const screenshotsLoaded = useScreenshotStore((state) => state.loaded);
  const refreshScreenshots = useScreenshotStore((state) => state.refresh);
  const [pendingDelete, setPendingDelete] = useState<{ localId: string; hasCloud: boolean } | null>(null);
  const [momentFilter, setMomentFilter] = useState<"all" | "favorites">("all");

  const recentClips = useMemo(() => {
    const pool = momentFilter === "favorites" ? clips.filter((clip) => clip.favorite) : clips;
    return pool.slice(0, 4);
  }, [clips, momentFilter]);

  const latestClip = clips.find((clip) => clip.captureKind !== "screenshot") ?? clips[0] ?? null;
  const latestDay = latestClip ? localDay(latestClip.createdAt) : null;
  const latestGameId = latestClip?.gameId ?? null;
  const sessionMedia = latestDay
    ? clips.filter(
        (clip) =>
          localDay(clip.createdAt) === latestDay &&
          (!latestGameId || clip.gameId === latestGameId),
      )
    : [];
  const sessionClipCount = sessionMedia.filter((clip) => !clip.captureKind || clip.captureKind === "clip").length;
  const sessionRecordingCount = sessionMedia.filter((clip) => clip.captureKind === "recording").length;
  const sessionPlayedMs = sessionMedia.reduce(
    (total, clip) => total + (clip.captureKind === "recording" ? clip.durationMs ?? 0 : 0),
    0,
  );
  const sessionScreenshotCount =
    sessionMedia.filter((clip) => clip.captureKind === "screenshot").length +
    (latestDay ? screenshots.filter((screenshot) => localDay(screenshot.createdAt) === latestDay).length : 0);
  const recentGameIds = Array.from(
    new Set(clips.map((clip) => clip.gameId).filter((gameId): gameId is string => Boolean(gameId))),
  );

  useEffect(() => {
    if (!screenshotsLoaded) void refreshScreenshots();
  }, [refreshScreenshots, screenshotsLoaded]);

  return (
    <div className="home-command">
      <header className="home-page-head">
        <div>
          <h1>Home</h1>
          <p className="muted">Your game. Your moments. All here.</p>
        </div>
      </header>

      <HeroCapturePanel />

      {clips.length === 0 ? (
        <section className="panel">
          <ClipGrid title="Your first clip lands here" body="Save an Instant Replay or start a full recording. Finished files stay on this PC." />
        </section>
      ) : (
        <section className="panel flush home-moments">
          <div className="panel-head home-moments-head">
            <div className="home-moments-title">
              <h2>Recent moments</h2>
              <span>{recentClips.length}</span>
            </div>
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
                View library →
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
                  onPlay={(item) => play(item.localId)}
                  onFavorite={(item) => void favorite(item.localId, !item.favorite)}
                  onUpload={user ? (item) => void upload(item.localId) : undefined}
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
                  variant="home"
                />
              ))}
            </div>
          )}
        </section>
      )}

      <div className="home-lower">
        <LastSessionCard
          clip={latestClip}
          clipCount={sessionClipCount}
          screenshotCount={sessionScreenshotCount}
          recordingCount={sessionRecordingCount}
          playedMs={sessionPlayedMs}
        />
        <GameProfilesCard recentGameIds={recentGameIds} />
      </div>
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
