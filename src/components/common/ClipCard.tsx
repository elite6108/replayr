import { convertFileSrc } from "@tauri-apps/api/core";
import { useState } from "react";
import type { LocalClip } from "../../types/clip";
import { useCloudStore } from "../../stores/cloudStore";
import { IconCloud, IconPlay, IconStar } from "../icons";
import { findLinkedCloudClip, normalizeUploadStatus } from "../../utils/clips";
import { formatClipDate, formatDuration, isVideoPath } from "../../utils/format";
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
}) {
  const cloudClips = useCloudStore((state) => state.clips);
  const linkedCloud = findLinkedCloudClip(clip, cloudClips);
  const thumb = clip.thumbnailPath || (clip.filePath.match(/\.(bmp|png|jpe?g|webp)$/i) ? clip.filePath : null);
  const status = normalizeUploadStatus(clip.uploadStatus);
  const uploading = ["queued", "preparing", "uploading", "processing"].includes(status);
  const inCloud = status === "completed" || Boolean(clip.cloudClipId || linkedCloud);
  const canUpload = Boolean(onUpload) && isVideoPath(clip.filePath) && !inCloud && !uploading;
  const badge = cloudBadge(clip, Boolean(linkedCloud));
  const date = formatClipDate(clip.createdAt);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(clip.title || "");

  function commitRename() {
    const title = draft.trim();
    setRenaming(false);
    if (title && title !== (clip.title || "")) onRename?.(clip, title);
  }

  return (
    <article
      className={`clip-card live ${clip.favorite ? "fav" : ""} ${selected ? "selected" : ""}`}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setMenu({ x: event.clientX, y: event.clientY });
      }}
    >
      {onSelect ? (
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
          {thumb ? <img src={convertFileSrc(thumb)} alt="" /> : <IconPlay size={22} />}
          <span className="clip-play" aria-hidden="true">
            <span>
              <IconPlay size={18} />
            </span>
          </span>
          {clip.durationMs ? <span className="clip-duration">{formatDuration(clip.durationMs)}</span> : null}
          {(clip.width ?? 0) > 0 && (clip.height ?? 0) > (clip.width ?? 0) ? (
            <span className="clip-aspect-badge" title="Vertical 9:16">
              9:16
            </span>
          ) : null}
          {badge ? (
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
            className="clip-rename"
            value={draft}
            autoFocus
            aria-label="Clip name"
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commitRename}
            onKeyDown={(event) => {
              if (event.key === "Enter") commitRename();
              if (event.key === "Escape") setRenaming(false);
            }}
          />
        ) : (
          <button
            type="button"
            className="clip-title-btn"
            title="Rename"
            onClick={() => {
              setDraft(clip.title || "");
              setRenaming(true);
            }}
          >
            {clip.title || "Untitled clip"}
          </button>
        )}
        <div className="clip-date">{date || "This PC"}</div>
      </div>
      {canUpload ? (
        <button type="button" className="clip-upload" title="Upload to cloud" onClick={() => onUpload?.(clip)}>
          <IconCloud size={14} />
        </button>
      ) : null}
      <button
        type="button"
        className={`clip-star ${clip.favorite ? "on" : ""}`}
        title={clip.favorite ? "Unfavorite" : "Favorite"}
        onClick={() => onFavorite(clip)}
      >
        <IconStar size={14} fill={clip.favorite ? "currentColor" : "none"} />
      </button>
      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: selected ? "Deselect" : "Select", onClick: () => onSelect?.(clip) },
            ...(onEdit && isVideoPath(clip.filePath)
              ? [{ label: "Edit", onClick: () => onEdit(clip) }]
              : []),
            {
              label: "Rename",
              onClick: () => {
                setDraft(clip.title || "");
                setRenaming(true);
              },
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
