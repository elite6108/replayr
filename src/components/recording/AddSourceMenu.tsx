import { useLayoutEffect, useRef } from "react";
import { REGISTRY_GROUPS, SOURCE_REGISTRY, capabilityCaption, clipSourceCaption, composedSourceCaption, sourceComposedSupported, sourceListedInAddMenu, type SourceRegistryEntry } from "../../recording/registry";
import { findSourceByType, isPrimaryCapture, type RecordingScene, type RecordingSourceType } from "../../recording/scene";
import type { StudioMode } from "../../recording/studioMode";

function placeAddSourceMenu(panel: HTMLDivElement) {
  const anchor = panel.closest(".studio-sources-block, .studio-audio-block");
  if (!(anchor instanceof HTMLElement)) return;
  const rect = anchor.getBoundingClientRect();
  const top = rect.top + 36;
  const height = Math.max(180, Math.min(520, window.innerHeight - top - 12));
  panel.style.position = "fixed";
  panel.style.top = `${Math.round(top)}px`;
  panel.style.left = `${Math.round(rect.left + 8)}px`;
  panel.style.width = `${Math.max(200, Math.round(rect.width - 16))}px`;
  panel.style.maxHeight = `${Math.round(height)}px`;
  panel.style.margin = "0";
  panel.style.zIndex = "40";
  panel.style.overflowY = "auto";
}

export function AddSourceMenu({
  scene,
  open,
  onClose,
  onAdd,
  groups,
  title = "Add Source",
  composed,
  studio = "recording",
}: {
  scene: RecordingScene;
  open: boolean;
  onClose: () => void;
  onAdd: (type: RecordingSourceType) => void;
  groups?: SourceRegistryEntry["group"][];
  title?: string;
  composed?: boolean;
  studio?: StudioMode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) return;
    const place = () => placeAddSourceMenu(panel);
    place();
    const anchor = panel.closest(".studio-sources-block, .studio-audio-block");
    const observer = anchor instanceof HTMLElement ? new ResizeObserver(place) : null;
    if (anchor instanceof HTMLElement) observer?.observe(anchor);
    window.addEventListener("resize", place);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [open]);
  if (!open) return null;
  const visible = groups ? REGISTRY_GROUPS.filter((group) => groups.includes(group.id)) : REGISTRY_GROUPS;

  return (
    <div ref={panelRef} className="add-source-menu" role="dialog" aria-label={title}>
      <div className="add-source-menu-head">
        <strong>{title}</strong>
        <button type="button" className="btn ghost sm" onClick={onClose}>
          Close
        </button>
      </div>
      {visible.map((group) => (
        <div key={group.id} className="add-source-group">
          <span className="settings-group-label">{group.label}</span>
          {SOURCE_REGISTRY.filter((entry) => sourceListedInAddMenu(entry, studio, [group.id])).map((entry) => {
            const existing = findSourceByType(scene, entry.type);
            const unsupported = entry.capability === "unsupported";
            const composedBlocked = Boolean(composed) && !sourceComposedSupported(entry.type);
            const taken = entry.unique && Boolean(existing) && !isPrimaryCapture(entry.type);
            const disabled = unsupported || taken || composedBlocked;
            const caption =
              studio === "clip"
                ? clipSourceCaption(entry.type) ?? capabilityCaption(entry.capability, studio)
                : taken
                  ? "Already added"
                  : composedSourceCaption(entry.type);
            return (
              <button
                key={entry.type}
                type="button"
                className="add-source-item"
                disabled={disabled}
                onClick={() => {
                  if (disabled) return;
                  onAdd(entry.type);
                  onClose();
                }}
              >
                <span>
                  {entry.label}
                  {caption ? <small>{caption}</small> : null}
                </span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
