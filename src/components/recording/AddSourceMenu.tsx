import { REGISTRY_GROUPS, SOURCE_REGISTRY, capabilityCaption, composedSourceCaption, sourceComposedSupported, type SourceRegistryEntry } from "../../recording/registry";
import { findSourceByType, isPrimaryCapture, type RecordingScene, type RecordingSourceType } from "../../recording/scene";

export function AddSourceMenu({
  scene,
  open,
  onClose,
  onAdd,
  groups,
  title = "Add Source",
  composed,
}: {
  scene: RecordingScene;
  open: boolean;
  onClose: () => void;
  onAdd: (type: RecordingSourceType) => void;
  groups?: SourceRegistryEntry["group"][];
  title?: string;
  composed?: boolean;
}) {
  if (!open) return null;
  const visible = groups ? REGISTRY_GROUPS.filter((group) => groups.includes(group.id)) : REGISTRY_GROUPS;

  return (
    <div className="add-source-menu" role="dialog" aria-label={title}>
      <div className="add-source-menu-head">
        <strong>{title}</strong>
        <button type="button" className="btn ghost sm" onClick={onClose}>
          Close
        </button>
      </div>
      {visible.map((group) => (
        <div key={group.id} className="add-source-group">
          <span className="settings-group-label">{group.label}</span>
          {SOURCE_REGISTRY.filter((entry) => entry.group === group.id).map((entry) => {
            const existing = findSourceByType(scene, entry.type);
            const unsupported = entry.capability === "unsupported";
            const composedBlocked = Boolean(composed) && !sourceComposedSupported(entry.type);
            const taken = entry.unique && Boolean(existing) && !isPrimaryCapture(entry.type);
            const disabled = unsupported || taken || composedBlocked;
            const caption = composedBlocked
              ? composedSourceCaption(entry.type)
              : taken
                ? "Already added"
                : capabilityCaption(entry.capability);
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
