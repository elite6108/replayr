import { useState } from "react";
import { ContextMenu } from "../common/ContextMenu";
import { IconMore, IconSpeaker, IconSpeakerOff } from "../icons";
import { capabilityCaption, registryEntry } from "../../recording/registry";
import { formatDb, formatPeakDb } from "../../recording/useStudioAudio";
import type { RecordingSource } from "../../recording/scene";
import { SourceGlyph } from "./sourceGlyph";
import { StudioMeter } from "./StudioMeter";

export function AudioSourceRow({
  source,
  selected,
  peak,
  gain,
  onSelect,
  onToggle,
  onRemove,
}: {
  source: RecordingSource;
  selected: boolean;
  peak: number;
  gain?: number;
  onSelect: () => void;
  onToggle: (enabled: boolean) => void;
  onRemove: () => void;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const entry = registryEntry(source.type);
  const caption = entry?.capability === "recorded" ? "" : (entry?.hint ?? capabilityCaption(source.capability));
  const level = Math.max(0, Math.min(1, peak));
  const reading = source.enabled ? (gain != null ? formatDb(gain) : formatPeakDb(peak)) : "Muted";

  return (
    <div className={`studio-source-row studio-audio-row${selected ? " is-selected" : ""}${source.enabled ? "" : " is-off"}`}>
      <button type="button" className="studio-source-main" onClick={onSelect}>
        <SourceGlyph type={source.type} />
        <span className="studio-source-copy">
          <span className="studio-audio-line">
            <span className="studio-source-name">{source.name}</span>
            <span className="studio-audio-db">{reading}</span>
          </span>
          {caption ? <span className="studio-source-cap">{caption}</span> : null}
          <StudioMeter level={level} compact />
        </span>
      </button>
      <div className="studio-source-actions">
        <button
          type="button"
          className="studio-icon-btn"
          title={source.enabled ? "Mute" : "Unmute"}
          onClick={() => onToggle(!source.enabled)}
        >
          {source.enabled ? <IconSpeaker size={15} /> : <IconSpeakerOff size={15} />}
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
          items={[{ label: "Remove", danger: true, onClick: onRemove }]}
        />
      ) : null}
    </div>
  );
}
