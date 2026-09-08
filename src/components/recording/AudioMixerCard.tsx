import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { IconHeadphones, IconMore, IconSpeaker, IconSpeakerOff } from "../icons";
import { ContextMenu } from "../common/ContextMenu";
import { formatDb } from "../../recording/useStudioAudio";
import type { RecordingSourceType } from "../../recording/scene";
import { audioSourceMenuItems } from "./audioSourceMenu";
import { SourceGlyph } from "./sourceGlyph";
import { VerticalAudioFader } from "./VerticalAudioFader";
import { VerticalAudioMeter } from "./VerticalAudioMeter";

export function AudioMixerCard({
  title,
  sourceType,
  selected,
  enabled,
  peak,
  gain,
  onSelect,
  onToggle,
  onGain,
  onProperties,
  onRemove,
}: {
  title: string;
  sourceType: RecordingSourceType;
  selected: boolean;
  enabled: boolean;
  peak: number;
  gain: number;
  onSelect: () => void;
  onToggle: (enabled: boolean) => void;
  onGain: (gain: number) => void;
  onProperties: () => void;
  onRemove: () => void;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  /** Visual-only monitor arm — does not route, capture, persist, or affect mix. */
  const [monitorArmed, setMonitorArmed] = useState(false);
  const navigate = useNavigate();
  const level = Math.max(0, Math.min(1, peak));

  function openMenu(x: number, y: number) {
    setMenu({ x, y });
  }

  return (
    <div
      className={`studio-mix-channel${enabled ? "" : " is-off"}${selected ? " is-selected" : ""}`}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        openMenu(event.clientX, event.clientY);
      }}
    >
      <button type="button" className="studio-mix-select" onClick={onSelect}>
        <div className="studio-mix-head">
          <span className="studio-mix-title">
            <SourceGlyph type={sourceType} />
            <strong>{title}</strong>
          </span>
          <span className="studio-mix-db">{enabled ? formatDb(gain) : "Muted"}</span>
        </div>
      </button>
      <div className="studio-mix-body">
        <VerticalAudioMeter level={enabled ? level : 0} />
        <VerticalAudioFader
          label={`${title} volume`}
          gain={gain}
          disabled={!enabled}
          onGain={onGain}
        />
      </div>
      <div className="studio-mix-tools">
        <button
          type="button"
          className={`studio-icon-btn studio-mix-tool${enabled ? " is-live" : ""}`}
          title={enabled ? "Mute" : "Unmute"}
          onClick={() => onToggle(!enabled)}
        >
          {enabled ? <IconSpeaker size={15} /> : <IconSpeakerOff size={15} />}
        </button>
        <button
          type="button"
          className={`studio-icon-btn studio-mix-tool studio-mix-monitor${monitorArmed ? " is-armed" : ""}`}
          title="Monitor (coming soon)"
          aria-pressed={monitorArmed}
          onClick={() => setMonitorArmed((value) => !value)}
        >
          <IconHeadphones size={15} />
        </button>
        <button
          type="button"
          className="studio-icon-btn studio-mix-tool"
          title="More"
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            openMenu(rect.right, rect.bottom + 4);
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
          items={audioSourceMenuItems({
            enabled,
            onAudioSettings: () => navigate("/settings?section=audio"),
            onProperties,
            onToggleMute: () => onToggle(!enabled),
            onRemove,
          })}
        />
      ) : null}
    </div>
  );
}
