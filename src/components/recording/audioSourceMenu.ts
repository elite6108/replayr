import type { MenuItem } from "../common/ContextMenu";

/** Shared Record-page audio source / mixer channel context actions. */
export function audioSourceMenuItems({
  enabled,
  onAudioSettings,
  onProperties,
  onInspect,
  onRename,
  onToggleMute,
  onRemove,
}: {
  enabled: boolean;
  onAudioSettings: () => void;
  onProperties: () => void;
  onInspect?: () => void;
  onRename?: () => void;
  onToggleMute: () => void;
  onRemove: () => void;
}): MenuItem[] {
  return [
    ...(onInspect ? [{ label: "Source inspector", onClick: onInspect }] : []),
    { label: "Audio Settings", onClick: onAudioSettings },
    { label: "Properties", onClick: onProperties },
    ...(onRename ? [{ label: "Rename", onClick: onRename }] : []),
    { label: enabled ? "Mute" : "Unmute", onClick: onToggleMute },
    { label: "Remove", danger: true, onClick: onRemove },
  ];
}
