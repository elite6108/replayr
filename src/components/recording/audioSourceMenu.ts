import type { MenuItem } from "../common/ContextMenu";

/** Shared Record-page audio source / mixer channel context actions. */
export function audioSourceMenuItems({
  enabled,
  onAudioSettings,
  onProperties,
  onToggleMute,
  onRemove,
}: {
  enabled: boolean;
  onAudioSettings: () => void;
  onProperties: () => void;
  onToggleMute: () => void;
  onRemove: () => void;
}): MenuItem[] {
  return [
    { label: "Audio Settings", onClick: onAudioSettings },
    { label: "Properties", onClick: onProperties },
    { label: enabled ? "Mute" : "Unmute", onClick: onToggleMute },
    { label: "Remove", danger: true, onClick: onRemove },
  ];
}
