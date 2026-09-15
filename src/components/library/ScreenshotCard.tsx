import { convertFileSrc } from "@tauri-apps/api/core";
import { useState } from "react";
import type { Screenshot } from "../../types/screenshot";
import { formatClipDate } from "../../utils/format";
import { ContextMenu } from "../common/ContextMenu";
import { IconCloud } from "../icons";

function statusBadge(shot: Screenshot): { state: "ready" | "busy" | "failed" | "local"; title: string } {
  if (shot.uploadStatus === "ready" && shot.shareUrl) {
    return { state: "ready", title: "Share link ready" };
  }
  if (shot.uploadStatus === "uploading") {
    return { state: "busy", title: "Uploading" };
  }
  if (shot.uploadStatus === "failed") {
    return { state: "failed", title: shot.uploadError || "Upload failed" };
  }
  if (shot.uploadStatus === "evicted") {
    return { state: "failed", title: "Cloud copy was replaced" };
  }
  return { state: "local", title: "Saved on this PC" };
}

export function ScreenshotCard({
  shot,
  selected,
  onSelect,
  onCopy,
  onReveal,
  onRetry,
  onDelete,
}: {
  shot: Screenshot;
  selected?: boolean;
  onSelect?: (shot: Screenshot) => void;
  onCopy: (shot: Screenshot, what: "image" | "link") => void;
  onReveal: (shot: Screenshot) => void;
  onRetry?: (shot: Screenshot) => void;
  onDelete?: (shot: Screenshot) => void;
}) {
  const thumb = shot.thumbPath || shot.filePath;
  const badge = statusBadge(shot);
  const date = formatClipDate(shot.createdAt);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const canLink = Boolean(shot.shareUrl && shot.uploadStatus === "ready");
  const canRetry = shot.uploadStatus === "failed" || shot.uploadStatus === "local" || shot.uploadStatus === "evicted";

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
            aria-label={`Select screenshot ${shot.width}×${shot.height}`}
            onChange={() => onSelect(shot)}
          />
        </label>
      ) : null}
      <button type="button" className="clip-open" onClick={() => onCopy(shot, canLink ? "link" : "image")}>
        <div className="clip-thumb">
          {thumb ? <img src={convertFileSrc(thumb)} alt="" loading="lazy" /> : null}
          <span className={`clip-cloud-badge ${badge.state === "local" ? "busy" : badge.state}`} title={badge.title}>
            <IconCloud size={14} fill={badge.state === "ready" ? "currentColor" : "none"} />
            <span>
              {badge.state === "failed"
                ? shot.uploadStatus === "evicted"
                  ? "Replaced"
                  : "Failed"
                : badge.state === "busy"
                  ? "Uploading"
                  : badge.state === "ready"
                    ? "Link"
                    : "This PC"}
            </span>
          </span>
        </div>
      </button>
      <div className="clip-meta">
        <span className="clip-title-btn" style={{ cursor: "default" }}>
          {shot.width}×{shot.height}
        </span>
        <div className="clip-date">{date || "This PC"}</div>
      </div>
      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: selected ? "Deselect" : "Select", onClick: () => onSelect?.(shot) },
            { label: "Copy image", onClick: () => onCopy(shot, "image") },
            { label: "Copy link", disabled: !canLink, onClick: () => onCopy(shot, "link") },
            { label: "Show in folder", onClick: () => onReveal(shot) },
            ...(canRetry && onRetry ? [{ label: "Upload again", onClick: () => onRetry(shot) }] : []),
            { label: "Delete", danger: true, onClick: () => onDelete?.(shot) },
          ]}
        />
      ) : null}
    </article>
  );
}
