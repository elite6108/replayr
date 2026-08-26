import { useState } from "react";
import type { CloudClip } from "../../types/clip";
import { IconCloud, IconPlay } from "../icons";
import { formatBytes, formatClipDate, formatDuration } from "../../utils/format";
import { ContextMenu } from "./ContextMenu";

export function CloudClipCard({
  clip,
  selected,
  onSelect,
  onPlay,
  onRename,
  onDelete,
  onDownload,
  onCopyLink,
}: {
  clip: CloudClip;
  selected?: boolean;
  onSelect?: (clip: CloudClip) => void;
  onPlay?: (clip: CloudClip) => void;
  onRename?: (clip: CloudClip, title: string) => void;
  onDelete?: (clip: CloudClip) => void;
  onDownload?: (clip: CloudClip) => void;
  onCopyLink?: (clip: CloudClip) => void;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(clip.title || "");
  const date = formatClipDate(clip.createdAt);
  const ready = clip.status === "ready";

  function commitRename() {
    const title = draft.trim();
    setRenaming(false);
    if (title && title !== (clip.title || "")) onRename?.(clip, title);
  }

  function remove() {
    if (!onDelete) return;
    if (!window.confirm("Delete this clip from the cloud and this PC? The share link will stop working.")) {
      return;
    }
    onDelete(clip);
  }

  return (
    <article
      className={`clip-card live ${selected ? "selected" : ""}`}
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
      <button
        type="button"
        className="clip-open"
        disabled={!ready || !onPlay}
        onClick={() => onPlay?.(clip)}
        title={ready ? "Play clip" : "Clip is not ready"}
      >
        <div className="clip-thumb">
          <IconPlay size={22} />
          {clip.durationMs ? <span className="clip-duration">{formatDuration(clip.durationMs)}</span> : null}
          <span className={`clip-cloud-badge ${ready ? "ready" : "busy"}`} title="In the cloud">
            <IconCloud size={14} fill="currentColor" />
            <span>Cloud</span>
          </span>
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
        <div className="clip-date">
          {date || clip.visibility}
          {clip.fileSizeBytes ? ` · ${formatBytes(clip.fileSizeBytes)}` : ""}
        </div>
      </div>
      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            {
              label: "Play",
              disabled: !ready,
              onClick: () => onPlay?.(clip),
            },
            { label: selected ? "Deselect" : "Select", onClick: () => onSelect?.(clip) },
            {
              label: "Rename",
              onClick: () => {
                setDraft(clip.title || "");
                setRenaming(true);
              },
            },
            { label: "Download", disabled: !ready, onClick: () => onDownload?.(clip) },
            { label: "Copy link", disabled: !ready, onClick: () => onCopyLink?.(clip) },
            { label: "Delete", danger: true, onClick: remove },
          ]}
        />
      ) : null}
    </article>
  );
}
