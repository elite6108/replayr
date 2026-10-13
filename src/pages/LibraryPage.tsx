import { useNavigate } from "react-router-dom";
import { useEffect, useMemo, useState, type MouseEvent } from "react";
import { AuthCard } from "../components/common/AuthCard";
import { ClipCard } from "../components/common/ClipCard";
import { ClipGrid } from "../components/common/ClipGrid";
import { CloudClipCard } from "../components/common/CloudClipCard";
import { DeleteClipDialog, type DeleteClipScope } from "../components/common/DeleteClipDialog";
import { SelectionBar } from "../components/common/SelectionBar";
import { LibraryChrome } from "../components/library/LibraryChrome";
import { LibraryInfoPane, type LibraryInfoModel } from "../components/library/LibraryInfoPane";
import { LibraryToolbar } from "../components/library/LibraryToolbar";
import { ScreenshotCard } from "../components/library/ScreenshotCard";
import { ScreenshotViewer } from "../components/library/ScreenshotViewer";
import { ScreenshotDowngradeBanner, ScreenshotUsageBar } from "../components/library/ScreenshotUsage";
import {
  clipCountLabel,
  filterLibraryRows,
  gameOf,
  groupLibraryRows,
  libraryRows,
  sortLibraryRows,
  type DateFilter,
  type DurationFilter,
  type LibraryInfoTarget,
  type LibraryLayout,
  type LibraryRow,
  type LibrarySort,
  type LibraryView,
} from "../library/libraryBrowse";
import { useAuthStore } from "../stores/authStore";
import { useCloudStore } from "../stores/cloudStore";
import { useDetectionStore } from "../stores/detectionStore";
import { useLibraryStore } from "../stores/libraryStore";
import { useScreenshotStore } from "../stores/screenshotStore";
import { convertFileSrc } from "@tauri-apps/api/core";
import { formatBytes, formatDuration, formatLibraryWhen, formatSpokenDuration, isVideoPath } from "../utils/format";

function resolutionLabel(width: number | null | undefined, height: number | null | undefined) {
  if (!width || !height) return "—";
  return `${width} × ${height}`;
}

function buildInfoModel(
  info: LibraryInfoTarget,
  clips: ReturnType<typeof useLibraryStore.getState>["clips"],
  cloudClips: ReturnType<typeof useCloudStore.getState>["clips"],
  catalog: ReturnType<typeof useDetectionStore.getState>["catalog"],
): LibraryInfoModel | null {
  if (info.kind === "local") {
    const clip = clips.find((item) => item.localId === info.id);
    if (!clip) return null;
    const game = gameOf(catalog, clip.gameId);
    const related = clips
      .filter((item) => item.localId !== clip.localId && clip.gameId && item.gameId === clip.gameId && item.captureKind !== "screenshot")
      .slice(0, 2)
      .map((item) => ({
        id: item.localId,
        title: item.title || "Untitled clip",
        thumbUrl: item.thumbnailPath ? convertFileSrc(item.thumbnailPath) : null,
        gameName: game?.name ?? null,
        whenLabel: formatLibraryWhen(item.createdAt),
        durationLabel: item.durationMs ? formatDuration(item.durationMs) : "",
      }));
    return {
      key: `local:${clip.localId}`,
      title: clip.title || "Untitled clip",
      thumbUrl: clip.thumbnailPath ? convertFileSrc(clip.thumbnailPath) : null,
      gameName: game?.name ?? null,
      gameArt: game?.iconUrl || game?.coverUrl || null,
      whenLabel: formatLibraryWhen(clip.createdAt),
      clockLabel: clip.durationMs ? formatDuration(clip.durationMs) : "",
      durationLabel: formatSpokenDuration(clip.durationMs),
      resolutionLabel: resolutionLabel(clip.width, clip.height),
      sizeLabel: clip.fileSize ? formatBytes(clip.fileSize) : "—",
      description: clip.description ?? "",
      tags: clip.tags ?? [],
      canEditMeta: true,
      canEdit: isVideoPath(clip.filePath),
      canShare: true,
      related,
    };
  }
  const clip = cloudClips.find((item) => item.id === info.id);
  if (!clip) return null;
  return {
    key: `cloud:${clip.id}`,
    title: clip.title || "Untitled clip",
    thumbUrl: clip.thumbnailUrl,
    gameName: null,
    gameArt: null,
    whenLabel: formatLibraryWhen(clip.createdAt),
    clockLabel: clip.durationMs ? formatDuration(clip.durationMs) : "",
    durationLabel: formatSpokenDuration(clip.durationMs),
    resolutionLabel: resolutionLabel(clip.width, clip.height),
    sizeLabel: clip.fileSizeBytes ? formatBytes(clip.fileSizeBytes) : "—",
    description: "",
    tags: [],
    canEditMeta: false,
    canEdit: false,
    canShare: clip.status === "ready" && clip.visibility !== "private",
    related: [],
  };
}

type PendingDelete =
  | { source: "local"; localIds: string[]; linkedCloud: boolean }
  | { source: "cloud"; cloudIds: string[]; allHaveLocal: boolean; anyHaveLocal: boolean };

export function LibraryPage({ view = "local" }: { view?: LibraryView }) {
  const navigate = useNavigate();
  const clips = useLibraryStore((state) => state.clips);
  const localError = useLibraryStore((state) => state.error);
  const refreshLocal = useLibraryStore((state) => state.refresh);
  const play = useLibraryStore((state) => state.play);
  const favorite = useLibraryStore((state) => state.favorite);
  const upload = useLibraryStore((state) => state.upload);
  const renameLocal = useLibraryStore((state) => state.rename);
  const setDescription = useLibraryStore((state) => state.setDescription);
  const setTags = useLibraryStore((state) => state.setTags);
  const removeBoth = useLibraryStore((state) => state.remove);
  const removeBothMany = useLibraryStore((state) => state.removeMany);
  const removeLocalOnly = useLibraryStore((state) => state.removeLocal);
  const removeLocalOnlyMany = useLibraryStore((state) => state.removeLocalMany);
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
  const removeCloudBoth = useCloudStore((state) => state.remove);
  const removeCloudBothMany = useCloudStore((state) => state.removeMany);
  const unlinkCloud = useCloudStore((state) => state.unlink);
  const unlinkCloudMany = useCloudStore((state) => state.unlinkMany);
  const renameCloud = useCloudStore((state) => state.rename);
  const downloadCloud = useCloudStore((state) => state.download);
  const downloadCloudMany = useCloudStore((state) => state.downloadMany);
  const copyCloudLink = useCloudStore((state) => state.copyLink);
  const setCloudVisibility = useCloudStore((state) => state.setVisibility);
  const playCloud = useCloudStore((state) => state.play);
  const toggleCloudSelect = useCloudStore((state) => state.toggleSelect);
  const selectAllCloud = useCloudStore((state) => state.selectAll);
  const clearCloudSelection = useCloudStore((state) => state.clearSelection);
  const selectedCloud = useCloudStore((state) => state.selectedIds);
  const catalog = useDetectionStore((state) => state.catalog);
  const [query, setQuery] = useState("");
  const [gameId, setGameId] = useState("all");
  const [dateFilter, setDateFilter] = useState<DateFilter>("any");
  const [durationFilter, setDurationFilter] = useState<DurationFilter>("any");
  const [layout, setLayout] = useState<LibraryLayout>("grid");
  const [sort, setSort] = useState<LibrarySort>("newest");
  const [info, setInfo] = useState<LibraryInfoTarget | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const screenshots = useScreenshotStore((state) => state.items);
  const screenshotsLoaded = useScreenshotStore((state) => state.loaded);
  const screenshotUsage = useScreenshotStore((state) => state.usage);
  const refreshScreenshots = useScreenshotStore((state) => state.refresh);
  const backfillScreenshotThumbs = useScreenshotStore((state) => state.backfillThumbs);
  const refreshScreenshotUsage = useScreenshotStore((state) => state.refreshUsage);
  const syncScreenshots = useScreenshotStore((state) => state.syncCloud);
  const copyScreenshot = useScreenshotStore((state) => state.copy);
  const revealScreenshot = useScreenshotStore((state) => state.reveal);
  const retryScreenshot = useScreenshotStore((state) => state.retry);
  const downloadScreenshot = useScreenshotStore((state) => state.download);
  const removeScreenshot = useScreenshotStore((state) => state.remove);
  const takeScreenshot = useScreenshotStore((state) => state.take);
  const [selectedShots, setSelectedShots] = useState<string[]>([]);
  const [pendingShotDelete, setPendingShotDelete] = useState<string[] | null>(null);
  const [openShotId, setOpenShotId] = useState<string | null>(null);
  const browsed = useMemo(() => {
    if (view === "screenshots") return [] as LibraryRow[];
    const filtered = filterLibraryRows(libraryRows({ view, clips, cloudClips }), {
      query,
      gameId,
      date: dateFilter,
      duration: durationFilter,
      catalog,
    });
    return sortLibraryRows(filtered, sort);
  }, [catalog, clips, cloudClips, dateFilter, durationFilter, gameId, query, sort, view]);
  const groups = useMemo(() => groupLibraryRows(browsed, sort), [browsed, sort]);
  const gameOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const clip of clips) {
      const game = gameOf(catalog, clip.gameId);
      if (!game) continue;
      seen.set(game.slug, game.name);
    }
    return [...seen.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [catalog, clips]);
  const used = storage?.storage_used_bytes ?? 0;
  const limit = storage?.storage_limit_bytes ?? 0;
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  const selectedLocalClips = browsed.flatMap((row) => (row.kind === "local" && selectedLocal.includes(row.id) ? [row.clip] : []));
  const selectedCloudLinked = selectedLocalClips.filter((clip) => clip.cloudClipId).length;
  const userId = user?.id;

  useEffect(() => {
    if (view === "screenshots") return;
    void refreshLocal();
    if (userId) void refreshCloud();
  }, [refreshCloud, refreshLocal, userId, view]);

  useEffect(() => {
    if (view !== "screenshots") return;
    let cancelled = false;
    void (async () => {
      await refreshScreenshots();
      if (cancelled) return;
      void refreshScreenshotUsage();
      void backfillScreenshotThumbs();
      if (userId) void syncScreenshots();
    })();
    return () => {
      cancelled = true;
    };
  }, [backfillScreenshotThumbs, refreshScreenshotUsage, refreshScreenshots, syncScreenshots, userId, view]);

  function openLocalDelete(localIds: string[]) {
    const linkedCloud = clips.some((clip) => localIds.includes(clip.localId) && clip.cloudClipId);
    setPendingDelete({ source: "local", localIds, linkedCloud });
  }

  function openCloudDelete(cloudIds: string[]) {
    const linked = cloudIds.map((id) => clips.some((clip) => clip.cloudClipId === id));
    setPendingDelete({
      source: "cloud",
      cloudIds,
      allHaveLocal: linked.length > 0 && linked.every(Boolean),
      anyHaveLocal: linked.some(Boolean),
    });
  }

  async function applyDelete(scope: DeleteClipScope) {
    const pending = pendingDelete;
    setPendingDelete(null);
    if (!pending) return;
    if (pending.source === "local") {
      const { localIds } = pending;
      if (scope === "pc") {
        if (localIds.length === 1) await removeLocalOnly(localIds[0]!);
        else await removeLocalOnlyMany(localIds);
        return;
      }
      if (scope === "cloud") {
        if (localIds.length === 1) await removeLocalFromCloud(localIds[0]!);
        else await removeLocalFromCloudMany(localIds);
        return;
      }
      if (localIds.length === 1) await removeBoth(localIds[0]!);
      else await removeBothMany(localIds);
      return;
    }
    const { cloudIds } = pending;
    if (scope === "cloud") {
      if (cloudIds.length === 1) await unlinkCloud(cloudIds[0]!);
      else await unlinkCloudMany(cloudIds);
      clearCloudSelection();
      return;
    }
    if (scope === "pc") {
      const localIds = clips.filter((clip) => clip.cloudClipId && cloudIds.includes(clip.cloudClipId)).map((clip) => clip.localId);
      if (localIds.length === 1) await removeLocalOnly(localIds[0]!);
      else if (localIds.length > 1) await removeLocalOnlyMany(localIds);
      return;
    }
    if (cloudIds.length === 1) await removeCloudBoth(cloudIds[0]!);
    else await removeCloudBothMany(cloudIds);
    clearCloudSelection();
  }

  const visibleShots = screenshots.filter((shot) => {
    const needle = query.trim().toLowerCase();
    if (!needle) return true;
    return `${shot.width}x${shot.height}`.includes(needle) || (shot.shareUrl ?? "").toLowerCase().includes(needle);
  });
  const selectedShotRows = visibleShots.filter((shot) => selectedShots.includes(shot.id));
  const openShot = screenshots.find((shot) => shot.id === openShotId) ?? null;

  async function applyShotDelete(scope: DeleteClipScope) {
    const ids = pendingShotDelete;
    setPendingShotDelete(null);
    if (!ids?.length) return;
    const deleteFile = scope === "pc" || scope === "both";
    const deleteCloud = scope === "cloud" || scope === "both";
    for (const id of ids) {
      await removeScreenshot(id, deleteFile, deleteCloud);
    }
    setSelectedShots([]);
  }

  useEffect(() => {
    setInfo(null);
  }, [view]);

  useEffect(() => {
    if (!info) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setInfo(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [info]);

  const infoModel = info ? buildInfoModel(info, clips, cloudClips, catalog) : null;
  const infoIndex = info ? browsed.findIndex((row) => row.kind === info.kind && row.id === info.id) : -1;

  function toggleInfo(next: LibraryInfoTarget) {
    setInfo((current) => (current?.kind === next.kind && current.id === next.id ? null : next));
  }

  function onStageMouseDown(event: MouseEvent) {
    const target = event.target as HTMLElement;
    if (target.closest(".clip-card, .library-info, .ctx-menu, .selection-bar, button, a, input, textarea, select, label")) return;
    setInfo(null);
  }

  function renderRow(row: LibraryRow) {
    const open = info?.kind === row.kind && info.id === row.id;
    if (row.kind === "local") {
      const clip = row.clip;
      return (
        <ClipCard
          key={clip.localId}
          variant="library"
          clip={clip}
          infoOpen={open}
          selected={selectedLocal.includes(clip.localId)}
          onPlay={(item) => play(item.localId)}
          onFavorite={(item) => void favorite(item.localId, !item.favorite)}
          onUpload={user ? (item) => void upload(item.localId) : undefined}
          onSelect={(item) => toggleLocalSelect(item.localId)}
          onRename={(item, title) => void renameLocal(item.localId, title)}
          onDelete={(item) => openLocalDelete([item.localId])}
          onRemoveFromCloud={(item) => {
            if (window.confirm("Remove this cloud copy? The file on this PC stays. The share link will stop working.")) {
              void removeLocalFromCloud(item.localId);
            }
          }}
          onDownload={(item) => void downloadLocal(item.localId)}
          onCopyLink={(item) => void copyLocalLink(item.localId)}
          onEdit={(item) => navigate(`/editor/${item.localId}`)}
          onInfo={(item) => toggleInfo({ kind: "local", id: item.localId })}
        />
      );
    }
    const clip = row.clip;
    return (
      <CloudClipCard
        key={clip.id}
        presentation="library"
        clip={clip}
        infoOpen={open}
        selected={selectedCloud.includes(clip.id)}
        onSelect={(item) => toggleCloudSelect(item.id)}
        onPlay={(item) => void playCloud(item.id)}
        onRename={(item, title) => void renameCloud(item.id, title)}
        onDelete={(item) => openCloudDelete([item.id])}
        onDownload={(item) => void downloadCloud(item.id)}
        onCopyLink={(item) => void copyCloudLink(item.id)}
        onVisibility={(item, visibility) => void setCloudVisibility(item.id, visibility)}
        onInfo={(item) => toggleInfo({ kind: "cloud", id: item.id })}
      />
    );
  }

  const cloudNeedsAccount = view === "cloud" && configured && !user;
  const emptyTitle = view === "favorites" ? "No favorites yet" : view === "cloud" ? "No cloud clips yet" : "Nothing saved yet";
  const emptyBody =
    view === "favorites"
      ? "Star a clip from the right-click menu to keep it here."
      : view === "cloud"
        ? "Open a local clip and choose Upload, or turn on automatic upload in Settings."
        : "Save an Instant Replay or stop a recording. Cloud copies from other PCs are under Cloud.";

  return (
    <>
      <LibraryChrome
        trailing={
          view === "screenshots" ? (
            <button type="button" className="btn primary" onClick={() => void takeScreenshot()}>
              Take screenshot
            </button>
          ) : null
        }
      />
      <LibraryToolbar
        query={query}
        onQuery={setQuery}
        games={gameOptions}
        gameId={gameId}
        onGame={setGameId}
        date={dateFilter}
        onDate={setDateFilter}
        duration={durationFilter}
        onDuration={setDurationFilter}
        showGame={view !== "screenshots" && view !== "cloud"}
        showDuration={view !== "screenshots"}
        layout={layout}
        onLayout={setLayout}
        sort={sort}
        onSort={setSort}
      />

      {view === "screenshots" ? (
        <>
          <ScreenshotDowngradeBanner usage={screenshotUsage} />
          {user ? <ScreenshotUsageBar usage={screenshotUsage} /> : null}
          {!screenshotsLoaded ? (
            <p className="muted">Loading screenshots…</p>
          ) : visibleShots.length === 0 ? (
            <ClipGrid
              title="No screenshots yet"
              body="Press the screenshot shortcut or Take screenshot. Drag a rectangle on the frozen screen."
            />
          ) : (
            <section className="library-results">
              <div className={`library-grid ${layout}`}>
                {visibleShots.map((shot) => (
                  <ScreenshotCard
                    key={shot.id}
                    shot={shot}
                    selected={selectedShots.includes(shot.id)}
                    onSelect={(item) =>
                      setSelectedShots((current) =>
                        current.includes(item.id) ? current.filter((id) => id !== item.id) : [...current, item.id],
                      )
                    }
                    onOpen={(item) => setOpenShotId(item.id)}
                    onCopy={(item, what) => void copyScreenshot(item.id, what)}
                    onReveal={(item) => void revealScreenshot(item.id)}
                    onRetry={user ? (item) => void retryScreenshot(item.id) : undefined}
                    onDelete={(item) => setPendingShotDelete([item.id])}
                  />
                ))}
              </div>
              <SelectionBar
                count={selectedShotRows.length}
                onClear={() => setSelectedShots([])}
                onSelectAll={() => setSelectedShots(visibleShots.map((shot) => shot.id))}
              >
                <button
                  type="button"
                  className="btn danger"
                  onClick={() => setPendingShotDelete(selectedShotRows.map((shot) => shot.id))}
                >
                  Delete
                </button>
              </SelectionBar>
            </section>
          )}
        </>
            ) : !configured && view === "cloud" ? (
        <section className="panel">
          <p>
            Copy <code>.env.example</code> to <code>.env</code> and set <code>VITE_SUPABASE_URL</code> and{" "}
            <code>VITE_SUPABASE_ANON_KEY</code>.
          </p>
        </section>
      ) : cloudNeedsAccount ? (
        <AuthCard />
      ) : (
        <div className={`library-stage ${infoModel ? "open" : ""}`} onMouseDown={onStageMouseDown}>
          <div className="library-results">
            {view === "cloud" && storage ? (
              <div className="library-storage">
                <span>Cloud storage</span>
                <strong>
                  {formatBytes(used)} / {formatBytes(limit)}
                </strong>
                <div className="meter" aria-label="Cloud storage used">
                  <span style={{ width: `${pct}%` }} />
                </div>
              </div>
            ) : null}
            {localError && view !== "cloud" ? <div className="error-text">{localError}</div> : null}
            {cloudError && (view === "cloud" || view === "all") ? <div className="error-text">{cloudError}</div> : null}
            {view === "cloud" && cloudLoading && browsed.length === 0 ? (
              <p className="muted">Loading cloud clips…</p>
            ) : browsed.length === 0 ? (
              <ClipGrid title={emptyTitle} body={emptyBody} />
            ) : (
              groups.map((group) => (
                <section key={group.id} className="library-section">
                  <div className="library-section-head">
                    <h2>{group.label}</h2>
                    <span className="library-count">{clipCountLabel(group.rows.length)}</span>
                  </div>
                  <div className={`library-grid ${layout}`}>{group.rows.map((row) => renderRow(row))}</div>
                </section>
              ))
            )}
            {selectedLocalClips.length > 0 ? (
              <SelectionBar
                count={selectedLocalClips.length}
                onClear={clearLocalSelection}
                onSelectAll={() => selectAllLocal(browsed.flatMap((row) => (row.kind === "local" ? [row.id] : [])))}
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
                <button type="button" className="btn danger" onClick={() => openLocalDelete(selectedLocalClips.map((clip) => clip.localId))}>
                  Delete
                </button>
              </SelectionBar>
            ) : null}
            {browsed.some((row) => row.kind === "cloud" && selectedCloud.includes(row.id)) ? (
              <SelectionBar
                count={browsed.filter((row) => row.kind === "cloud" && selectedCloud.includes(row.id)).length}
                onClear={clearCloudSelection}
                onSelectAll={() => selectAllCloud(browsed.flatMap((row) => (row.kind === "cloud" ? [row.id] : [])))}
              >
                <button
                  type="button"
                  className="btn"
                  onClick={() =>
                    void downloadCloudMany(browsed.flatMap((row) => (row.kind === "cloud" && selectedCloud.includes(row.id) ? [row.id] : [])))
                  }
                >
                  Download
                </button>
                <button
                  type="button"
                  className="btn danger"
                  onClick={() => openCloudDelete(browsed.flatMap((row) => (row.kind === "cloud" && selectedCloud.includes(row.id) ? [row.id] : [])))}
                >
                  Delete
                </button>
              </SelectionBar>
            ) : null}
          </div>
          {info && infoModel ? (
            <LibraryInfoPane
              model={infoModel}
              hasPrev={infoIndex > 0}
              hasNext={infoIndex >= 0 && infoIndex < browsed.length - 1}
              onPrev={() => {
                const next = browsed[infoIndex - 1];
                if (next) setInfo({ kind: next.kind, id: next.id });
              }}
              onNext={() => {
                const next = browsed[infoIndex + 1];
                if (next) setInfo({ kind: next.kind, id: next.id });
              }}
              onPlay={() => {
                if (info.kind === "local") play(info.id);
                else void playCloud(info.id);
              }}
              onEdit={() => {
                if (info.kind === "local") navigate(`/editor/${info.id}`);
              }}
              onShare={() => {
                if (info.kind === "local") void copyLocalLink(info.id);
                else void copyCloudLink(info.id);
              }}
              onRename={(title) => {
                if (info.kind === "local") void renameLocal(info.id, title);
                else void renameCloud(info.id, title);
              }}
              onDescription={(description) => {
                if (info.kind === "local") void setDescription(info.id, description);
              }}
              onTags={(tags) => {
                if (info.kind === "local") void setTags(info.id, tags);
              }}
              onRelated={(id) => setInfo({ kind: "local", id })}
              onSeeAll={() => {
                if (info.kind !== "local") return;
                const clip = clips.find((item) => item.localId === info.id);
                const game = gameOf(catalog, clip?.gameId);
                if (game) setGameId(game.slug);
              }}
              moreItems={
                info.kind === "local"
                  ? [
                      { label: "Download", onClick: () => void downloadLocal(info.id) },
                      { label: "Delete", danger: true, onClick: () => openLocalDelete([info.id]) },
                    ]
                  : [
                      { label: "Download", onClick: () => void downloadCloud(info.id) },
                      { label: "Delete", danger: true, onClick: () => openCloudDelete([info.id]) },
                    ]
              }
            />
          ) : null}
        </div>
      )}
      {pendingDelete ? (
        <DeleteClipDialog
          count={pendingDelete.source === "local" ? pendingDelete.localIds.length : pendingDelete.cloudIds.length}
          showPc={pendingDelete.source === "local" || pendingDelete.allHaveLocal}
          showCloud={pendingDelete.source === "cloud" || pendingDelete.linkedCloud}
          showBoth={
            pendingDelete.source === "local"
              ? pendingDelete.linkedCloud
              : pendingDelete.anyHaveLocal
          }
          onClose={() => setPendingDelete(null)}
          onChoose={(scope) => void applyDelete(scope)}
        />
      ) : null}
      {pendingShotDelete ? (
        <DeleteClipDialog
          noun="screenshot"
          count={pendingShotDelete.length}
          showPc
          showCloud={screenshots.some((shot) => pendingShotDelete.includes(shot.id) && shot.cloudId && shot.uploadStatus === "ready")}
          showBoth={screenshots.some((shot) => pendingShotDelete.includes(shot.id) && shot.cloudId && shot.uploadStatus === "ready")}
          onClose={() => setPendingShotDelete(null)}
          onChoose={(scope) => void applyShotDelete(scope)}
        />
      ) : null}
      {openShot ? (
        <ScreenshotViewer
          shot={openShot}
          onClose={() => setOpenShotId(null)}
          onDownload={() => void downloadScreenshot(openShot.id)}
        />
      ) : null}
    </>
  );
}
