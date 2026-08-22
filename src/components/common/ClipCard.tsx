import { convertFileSrc } from "@tauri-apps/api/core";
import { useState } from "react";
import type { LocalClip } from "../../types/clip";
import { IconCloud, IconPlay, IconStar } from "../icons";
import { formatDuration, isVideoPath } from "../../utils/format";
import { ContextMenu } from "./ContextMenu";

export function ClipCard({
  clip,
  selected,
  onPlay,
  onFavorite,
  onUpload,
  onSelect,
  onRename,
  onDelete,
  onDownload,
  onCopyLink,
}: {
  clip: LocalClip;
  selected?: boolean;
  onPlay: (clip: LocalClip) => void;
  onFavorite: (clip: LocalClip) => void;
  onUpload?: (clip: LocalClip) => void;
  onSelect?: (clip: LocalClip) => void;
  onRename?: (clip: LocalClip, title: string) => void;
  onDelete?: (clip: LocalClip) => void;
  onDownload?: (clip: LocalClip) => void;
  onCopyLink?: (clip: LocalClip) => void;
}) {
  const thumb = clip.thumbnailPath || (clip.filePath.match(/\.(bmp|png|jpe?g|webp)$/i) ? clip.filePath : null);
  const uploading = ["queued", "preparing", "uploading", "processing"].includes(clip.uploadStatus);
  const canUpload = Boolean(onUpload) && isVideoPath(clip.filePath) && clip.uploadStatus !== "completed" && !uploading;
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
      <button type="button" className="clip-open" onClick={() => onPlay(clip)}>
        <div className="clip-thumb">
          {thumb ? <img src={convertFileSrc(thumb)} alt="" /> : <IconPlay size={22} />}
          <span className="clip-play" aria-hidden="true">
            <span>
              <IconPlay size={18} />
            </span>
          </span>
          {clip.durationMs ? <span className="clip-duration">{formatDuration(clip.durationMs)}</span> : null}
          {clip.uploadStatus && clip.uploadStatus !== "local" ? (
            <span className="clip-flag">{clip.uploadStatus}</span>
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
        <div className="muted">{clip.gameId || "Local"}</div>
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
            {
              label: "Rename",
              onClick: () => {
                setDraft(clip.title || "");
                setRenaming(true);
              },
            },
            { label: "Download", onClick: () => onDownload?.(clip) },
            { label: "Copy link", onClick: () => onCopyLink?.(clip) },
            { label: "Delete", danger: true, onClick: () => onDelete?.(clip) },
          ]}
        />
      ) : null}
    </article>
  );
}
