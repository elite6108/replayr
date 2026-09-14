import type { MenuItem } from "../common/ContextMenu";

/** Shared Record-page audio source / mixer channel context actions. */
export function audioSourceMenuItems({
  enabled,
  onAudioSettings,
  onProperties,
  onRename,
  onToggleMute,
  onRemove,
}: {
  enabled: boolean;
  onAudioSettings: () => void;
  onProperties: () => void;
  onRename?: () => void;
  onToggleMute: () => void;
  onRemove: () => void;
}): MenuItem[] {
  return [
    { label: "Audio Settings", onClick: onAudioSettings },
    { label: "Properties", onClick: onProperties },
    ...(onRename ? [{ label: "Rename", onClick: onRename }] : []),
    { label: enabled ? "Mute" : "Unmute", onClick: onToggleMute },
    { label: "Remove", danger: true, onClick: onRemove },
  ];
}
