import { useState, type PointerEvent as ReactPointerEvent } from "react";
import { ContextMenu } from "../common/ContextMenu";
import { IconEye, IconEyeOff, IconGrip, IconLock, IconMore, IconUnlock } from "../icons";
import { capabilityCaption, composedSourceCaption, registryEntry, sourceComposedSupported } from "../../recording/registry";
import type { RecordingOutputMode, RecordingSource } from "../../recording/scene";
import { SourceGlyph } from "./sourceGlyph";

export function VisualSourceRow({
  source,
  outputMode,
  selected,
  onSelect,
  onToggle,
  onLock,
  onMove,
  onRemove,
  onProperties,
  onRename,
  onGripDown,
  dropBefore,
  compositionLocked,
}: {
  source: RecordingSource;
  outputMode?: RecordingOutputMode;
  selected: boolean;
  onSelect: () => void;
  onToggle: (enabled: boolean) => void;
  onLock: (locked: boolean) => void;
  onMove: (direction: "front" | "back") => void;
  onRemove: () => void;
  onProperties: () => void;
  onRename: () => void;
  onGripDown: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  dropBefore?: boolean;
  compositionLocked?: boolean;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const entry = registryEntry(source.type);
  const composedUnsupported = outputMode === "composed" && !sourceComposedSupported(source.type);
  const composedCap = outputMode === "composed" ? composedSourceCaption(source.type) : null;
  const caption =
    composedCap ?? (entry?.capability === "recorded" ? "" : (entry?.hint ?? capabilityCaption(source.capability)));

  return (
    <div
      data-visual-source-id={source.id}
      className={`studio-source-row studio-visual-row${selected ? " is-selected" : ""}${source.enabled ? "" : " is-off"}${dropBefore ? " is-drop-before" : ""}`}
      onContextMenu={(event) => {
        event.preventDefault();
        setMenu({ x: event.clientX, y: event.clientY });
      }}
    >
      <button
        type="button"
        className="studio-drag"
        title="Drag to reorder"
        disabled={compositionLocked}
        onPointerDown={onGripDown}
      >
        <IconGrip size={14} />
      </button>
      <button type="button" className="studio-source-main" onClick={onSelect}>
        <SourceGlyph type={source.type} />
        <span className="studio-source-copy">
          <span className="studio-source-name">{source.name}</span>
          {caption ? <span className="studio-source-cap">{caption}</span> : null}
        </span>
      </button>
      <div className="studio-source-actions">
        <button
          type="button"
          className={`studio-icon-btn${source.enabled ? "" : " is-dim"}`}
          title={composedUnsupported ? "Not yet available in composed recording" : source.enabled ? "Hide" : "Show"}
          disabled={compositionLocked || (composedUnsupported && !source.enabled)}
          onClick={() => {
            if (composedUnsupported && !source.enabled) return;
            onToggle(!source.enabled);
          }}
        >
          {source.enabled ? <IconEye size={15} /> : <IconEyeOff size={15} />}
        </button>
        <button
          type="button"
          className={`studio-icon-btn${source.locked ? " is-on" : ""}`}
          title={source.locked ? "Unlock" : "Lock"}
          disabled={compositionLocked}
          onClick={() => onLock(!source.locked)}
        >
          {source.locked ? <IconLock size={15} /> : <IconUnlock size={15} />}
        </button>
        <button
          type="button"
          className="studio-icon-btn"
          title="More"
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            setMenu({ x: rect.right, y: rect.bottom + 4 });
          }}
        >
          <IconMore size={15} />
        </button>
      </div>
      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={
            compositionLocked
              ? [{ label: "Layout changes apply to the next recording.", onClick: () => undefined }]
              : [
                  { label: "Properties", onClick: onProperties },
                  { label: "Rename", onClick: onRename },
                  { label: source.enabled ? "Hide" : "Show", onClick: () => onToggle(!source.enabled) },
                  { label: source.locked ? "Unlock" : "Lock", onClick: () => onLock(!source.locked) },
                  { label: "Move forward", onClick: () => onMove("front") },
                  { label: "Move back", onClick: () => onMove("back") },
                  { label: "Remove", danger: true, onClick: onRemove },
                ]
          }
        />
      ) : null}
    </div>
  );
}
