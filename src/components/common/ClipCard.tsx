import { convertFileSrc } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import clipCamIcon from "../../assets/figma/home/clip-cam.svg";
import cloudIcon from "../../assets/figma/home/cloud.svg";
import dateDot from "../../assets/figma/home/dot.svg";
import displayIcon from "../../assets/figma/home/display.svg";
import dotsIcon from "../../assets/figma/home/dots.svg";
import penIcon from "../../assets/figma/home/pen.svg";
import playIcon from "../../assets/figma/home/play.svg";
import shareIcon from "../../assets/figma/home/share.svg";
import starOffIcon from "../../assets/figma/home/star-off.svg";
import starOnIcon from "../../assets/figma/home/star-on.svg";
import type { LocalClip } from "../../types/clip";
import { useCloudStore } from "../../stores/cloudStore";
import { IconCloud, IconMore, IconPencil, IconPlay, IconShare, IconStar } from "../icons";
import { findLinkedCloudClip, normalizeUploadStatus } from "../../utils/clips";
import { formatDuration, formatLibraryWhen, formatRelativeTime, isVideoPath } from "../../utils/format";
import { useDetectionStore } from "../../stores/detectionStore";
import { ContextMenu } from "./ContextMenu";

function cloudBadge(
  clip: LocalClip,
  linked: boolean,
): { state: "ready" | "busy" | "failed"; title: string } | null {
  const status = normalizeUploadStatus(clip.uploadStatus);
  if (status === "completed" || linked || clip.cloudClipId) {
    return { state: "ready", title: "In the cloud" };
  }
  if (["queued", "preparing", "uploading", "processing"].includes(status)) {
    return { state: "busy", title: "Uploading to cloud" };
  }
  if (status === "failed") {
    return { state: "failed", title: "Cloud upload failed" };
  }
  return null;
}

export function ClipCard({
  clip,
  selected,
  onPlay,
  onFavorite,
  onUpload,
  onSelect,
  onRename,
  onDelete,
  onRemoveFromCloud,
  onDownload,
  onCopyLink,
  onEdit,
  onInfo,
  infoOpen = false,
  variant = "default",
}: {
  clip: LocalClip;
  selected?: boolean;
  onPlay: (clip: LocalClip) => void;
  onFavorite: (clip: LocalClip) => void;
  onUpload?: (clip: LocalClip) => void;
  onSelect?: (clip: LocalClip) => void;
  onRename?: (clip: LocalClip, title: string) => void;
  onDelete?: (clip: LocalClip) => void;
  onRemoveFromCloud?: (clip: LocalClip) => void;
  onDownload?: (clip: LocalClip) => void;
  onCopyLink?: (clip: LocalClip) => void;
  onEdit?: (clip: LocalClip) => void;
  onInfo?: (clip: LocalClip) => void;
  infoOpen?: boolean;
  variant?: "default" | "home" | "library";
}) {
  const catalog = useDetectionStore((state) => state.catalog);
  const cloudClips = useCloudStore((state) => state.clips);
  const linkedCloud = findLinkedCloudClip(clip, cloudClips);
  const thumb = clip.thumbnailPath || (clip.filePath.match(/\.(bmp|png|jpe?g|webp)$/i) ? clip.filePath : null);
  const status = normalizeUploadStatus(clip.uploadStatus);
  const uploading = ["queued", "preparing", "uploading", "processing"].includes(status);
  const inCloud = status === "completed" || Boolean(clip.cloudClipId || linkedCloud);
  const canUpload = Boolean(onUpload) && isVideoPath(clip.filePath) && !inCloud && !uploading;
  const badge = cloudBadge(clip, Boolean(linkedCloud));
  const relativeDate = formatRelativeTime(clip.createdAt);
  const date =
    variant === "home"
      ? relativeDate
          .replace(/\bminutes?\b/, "min")
          .replace(/\bhours?\b/, "hr")
      : relativeDate;
  const game = catalog.find((entry) => entry.slug === clip.gameId || entry.cloudId === clip.gameId);
  const gameName = game?.name;
  const gameArt = game?.iconUrl || game?.coverUrl || null;
  const library = variant === "library";
  const onPc = Boolean(clip.filePath);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(clip.title || "");
  const renameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!renaming) return;
    const input = renameRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, [renaming]);

  function beginRename() {
    setDraft(clip.title || "");
    setRenaming(true);
  }

  function commitRename() {
    const title = draft.trim();
    setRenaming(false);
    if (title && title !== (clip.title || "")) onRename?.(clip, title);
  }

  return (
    <article
      className={`clip-card live ${variant === "home" ? "clip-card-home" : ""} ${library ? "clip-card-library" : ""} ${clip.favorite ? "fav" : ""} ${selected ? "selected" : ""} ${infoOpen ? "info-open" : ""}`}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setMenu({ x: event.clientX, y: event.clientY });
      }}
    >
      {onSelect && !library ? (
        <label className="clip-check">
          <input
            type="checkbox"
            checked={Boolean(selected)}
            aria-label={`Select ${clip.title || "clip"}`}
            onChange={() => onSelect(clip)}
          />
        </label>
      ) : null}
      <button type="button" className="clip-open" onClick={() => onPlay(clip)}>
        <div className="clip-thumb">
          {thumb ? <img src={convertFileSrc(thumb)} alt="" loading="lazy" /> : <IconPlay size={22} />}
          <span className={`clip-play ${infoOpen ? "is-visible" : ""}`} aria-hidden="true">
            <span>
              {variant === "home" ? <img className="asset" src={playIcon} alt="" draggable={false} /> : <IconPlay size={18} />}
            </span>
          </span>
          {variant === "home" ? (
            <span className="clip-type-badge">
              <img className="asset" src={clipCamIcon} alt="" draggable={false} />
              {clip.captureKind === "recording" ? "Recording" : clip.captureKind === "screenshot" ? "Screenshot" : "Clip"}
            </span>
          ) : null}
          {clip.durationMs ? <span className="clip-duration">{formatDuration(clip.durationMs)}</span> : null}
          {(clip.width ?? 0) > 0 && (clip.height ?? 0) > (clip.width ?? 0) ? (
            <span className="clip-aspect-badge" title="Vertical 9:16">
              9:16
            </span>
          ) : null}
          {badge && !library ? (
            <span className={`clip-cloud-badge ${badge.state}`} title={badge.title}>
              <IconCloud size={14} fill={badge.state === "ready" ? "currentColor" : "none"} />
              <span>{badge.state === "failed" ? "Failed" : badge.state === "busy" ? "Uploading" : "Cloud"}</span>
            </span>
          ) : null}
        </div>
      </button>
      <div className="clip-meta">
        {renaming ? (
          <input
            ref={renameRef}
            className="clip-rename"
            value={draft}
            aria-label="Clip name"
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commitRename}
            onKeyDown={(event) => {
              if (event.key === "Enter") commitRename();
              if (event.key === "Escape") setRenaming(false);
            }}
          />
        ) : library ? (
          <h3 className="clip-title">{clip.title || "Untitled clip"}</h3>
        ) : (
          <button
            type="button"
            className="clip-title-btn"
            title="Rename"
            onMouseDown={(event) => event.preventDefault()}
            onClick={beginRename}
          >
            {clip.title || "Untitled clip"}
          </button>
        )}
        {library && gameName ? (
          <div className="clip-game-row">
            {gameArt ? <img src={gameArt} alt="" /> : <span className="clip-game-fallback" />}
            <span>{gameName}</span>
          </div>
        ) : null}
        <div className="clip-date">
          {library ? (
            formatLibraryWhen(clip.createdAt)
          ) : variant === "home" && gameName ? (
            <>
              <span>{gameName}</span>
              <img className="asset" src={dateDot} alt="" draggable={false} />
              <span>{date}</span>
            </>
          ) : gameName ? (
            `${gameName} · ${date}`
          ) : (
            date
          )}
        </div>
        {library ? null : <div className="clip-tags">
          {onPc ? (
            <span>
              {variant === "home" ? <img className="asset" src={displayIcon} alt="" draggable={false} /> : null}
              This PC
            </span>
          ) : null}
          {inCloud ? (
            <span className={variant === "home" ? "is-cloud" : undefined}>
              {variant === "home" ? <img className="asset" src={cloudIcon} alt="" draggable={false} /> : <IconCloud size={12} />}
              Cloud
            </span>
          ) : null}
        </div>}
        {library ? null : <div className="clip-footer-actions">
          {onEdit && isVideoPath(clip.filePath) ? (
            <button type="button" title="Edit" onClick={() => onEdit(clip)}>
              {variant === "home" ? <img className="asset" src={penIcon} alt="" draggable={false} /> : <IconPencil size={14} />}
            </button>
          ) : null}
          {onCopyLink ? (
            <button type="button" title="Share" onClick={() => onCopyLink(clip)}>
              {variant === "home" ? <img className="asset" src={shareIcon} alt="" draggable={false} /> : <IconShare size={14} />}
            </button>
          ) : null}
          <button
            type="button"
            title="More"
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              setMenu({ x: rect.left, y: rect.bottom + 4 });
            }}
          >
            {variant === "home" ? <img className="asset" src={dotsIcon} alt="" draggable={false} /> : <IconMore size={16} />}
          </button>
        </div>}
      </div>
      {canUpload && !library ? (
        <button type="button" className="clip-upload" title="Upload to cloud" onClick={() => onUpload?.(clip)}>
          <IconCloud size={14} />
        </button>
      ) : null}
      {library ? null : (
      <button
        type="button"
        className={`clip-star ${clip.favorite ? "on" : ""}`}
        title={clip.favorite ? "Unfavorite" : "Favorite"}
        onClick={() => onFavorite(clip)}
      >
        {variant === "home" ? (
          <img className="asset" src={clip.favorite ? starOnIcon : starOffIcon} alt="" draggable={false} />
        ) : (
          <IconStar size={14} fill={clip.favorite ? "currentColor" : "none"} />
        )}
      </button>
      )}
      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            ...(onInfo ? [{ label: "Info", onClick: () => onInfo(clip) }] : []),
            ...(library ? [{ label: clip.favorite ? "Unfavorite" : "Favorite", onClick: () => onFavorite(clip) }] : []),
            ...(library && canUpload ? [{ label: "Upload", onClick: () => onUpload?.(clip) }] : []),
            ...(onSelect ? [{ label: selected ? "Deselect" : "Select", onClick: () => onSelect(clip) }] : []),
            ...(onEdit && isVideoPath(clip.filePath)
              ? [{ label: "Edit", onClick: () => onEdit(clip) }]
              : []),
            {
              label: "Rename",
              onClick: beginRename,
            },
            { label: "Download", onClick: () => onDownload?.(clip) },
            { label: "Copy link", onClick: () => onCopyLink?.(clip) },
            ...(inCloud && onRemoveFromCloud
              ? [
                  {
                    label: "Remove from cloud",
                    onClick: () => onRemoveFromCloud({ ...clip, cloudClipId: clip.cloudClipId || linkedCloud?.id || null }),
                  },
                ]
              : []),
            { label: "Delete", danger: true, onClick: () => onDelete?.(clip) },
          ]}
        />
      ) : null}
    </article>
  );
}
