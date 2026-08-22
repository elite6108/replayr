import { useState } from "react";
import type { CloudClip } from "../../types/clip";
import { IconPlay } from "../icons";
import { formatBytes, formatDuration } from "../../utils/format";
import { ContextMenu } from "./ContextMenu";

export function CloudClipCard({
  clip,
  selected,
  onSelect,
  onRename,
  onDelete,
  onDownload,
  onCopyLink,
}: {
  clip: CloudClip;
  selected?: boolean;
  onSelect?: (clip: CloudClip) => void;
  onRename?: (clip: CloudClip, title: string) => void;
  onDelete?: (clip: CloudClip) => void;
  onDownload?: (clip: CloudClip) => void;
  onCopyLink?: (clip: CloudClip) => void;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(clip.title || "");

  function commitRename() {
    const title = draft.trim();
    setRenaming(false);
    if (title && title !== (clip.title || "")) onRename?.(clip, title);
  }

  function remove() {
    if (!onDelete) return;
    if (!window.confirm("Delete this cloud copy? The file on this PC stays. The share link will stop working.")) {
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
      <div className="clip-open">
        <div className="clip-thumb">
          <IconPlay size={22} />
          <span className="clip-duration">{clip.status}</span>
        </div>
      </div>
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
        <div className="muted">
          {clip.visibility}
          {clip.durationMs ? ` · ${formatDuration(clip.durationMs)}` : ""}
          {clip.fileSizeBytes ? ` · ${formatBytes(clip.fileSizeBytes)}` : ""}
        </div>
      </div>
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
            { label: "Download", disabled: clip.status !== "ready", onClick: () => onDownload?.(clip) },
            { label: "Copy link", disabled: clip.status !== "ready", onClick: () => onCopyLink?.(clip) },
            { label: "Delete", danger: true, onClick: remove },
          ]}
        />
      ) : null}
    </article>
  );
}
