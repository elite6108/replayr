import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { IconMore, IconSpeaker, IconSpeakerOff } from "../icons";
import { ContextMenu } from "../common/ContextMenu";
import type { AppSettings } from "../../types/settings";
import { findSourceByType, type RecordingScene } from "../../recording/scene";
import { formatDb } from "../../recording/useStudioAudio";
import { StudioMeter } from "./StudioMeter";

export function AudioMixer({
  scene,
  settings,
  selectedId,
  levels,
  onSelect,
  onToggleMic,
  onToggleGame,
  onToggleDesktop,
  onSave,
}: {
  scene: RecordingScene;
  settings: AppSettings;
  selectedId: string | null;
  levels: { micPeak: number; gamePeak: number; desktopPeak: number };
  onSelect: (id: string | null) => void;
  onToggleMic: (enabled: boolean) => void;
  onToggleGame: (enabled: boolean) => void;
  onToggleDesktop: (enabled: boolean) => void;
  onSave: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
}) {
  const mic = findSourceByType(scene, "microphone");
  const game = findSourceByType(scene, "gameAudio");
  const desktop = findSourceByType(scene, "desktopAudio");

  return (
    <section className="studio-panel studio-mixer">
      <div className="studio-block-head">
        <h2>Audio Mixer</h2>
      </div>
      <div className="studio-mixer-row">
        <MixerChannel
          title="Microphone"
          selected={selectedId === mic?.id}
          enabled={Boolean(mic?.enabled)}
          peak={levels.micPeak}
          gain={settings.micGain}
          onSelect={() => onSelect(mic?.id ?? null)}
          onToggle={onToggleMic}
          onGain={(gain) => onSave("micGain", gain)}
        />
        <MixerChannel
          title="Desktop Audio"
          selected={selectedId === desktop?.id}
          enabled={Boolean(desktop?.enabled)}
          peak={levels.desktopPeak}
          onSelect={() => onSelect(desktop?.id ?? null)}
          onToggle={onToggleDesktop}
        />
        <MixerChannel
          title="Game Audio"
          selected={selectedId === game?.id}
          enabled={Boolean(game?.enabled)}
          peak={levels.gamePeak}
          gain={settings.gameAudioGain}
          onSelect={() => onSelect(game?.id ?? null)}
          onToggle={onToggleGame}
          onGain={(gain) => onSave("gameAudioGain", gain)}
        />
      </div>
    </section>
  );
}

function MixerChannel({
  title,
  selected,
  enabled,
  peak,
  gain,
  onSelect,
  onToggle,
  onGain,
}: {
  title: string;
  selected: boolean;
  enabled: boolean;
  peak: number;
  gain?: number;
  onSelect: () => void;
  onToggle: (enabled: boolean) => void;
  onGain?: (gain: number) => void;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const navigate = useNavigate();
  const level = Math.max(0, Math.min(1, peak));

  return (
    <div className={`studio-mix-channel${enabled ? "" : " is-off"}${selected ? " is-selected" : ""}`}>
      <button type="button" className="studio-mix-select" onClick={onSelect}>
        <div className="studio-mix-head">
          <strong>{title}</strong>
          <span>{onGain && enabled ? formatDb(gain ?? 1) : enabled ? "Open" : "Muted"}</span>
        </div>
        <StudioMeter level={level} />
      </button>
      <div className="studio-mix-tools">
        <button type="button" className="studio-icon-btn" title={enabled ? "Mute" : "Unmute"} onClick={() => onToggle(!enabled)}>
          {enabled ? <IconSpeaker size={15} /> : <IconSpeakerOff size={15} />}
        </button>
        {onGain ? (
          <input
            type="range"
            min={0}
            max={200}
            step={1}
            disabled={!enabled}
            aria-label={`${title} volume`}
            value={Math.round((gain ?? 1) * 100)}
            onChange={(event) => onGain(Number(event.target.value) / 100)}
          />
        ) : (
          <span className="studio-mix-spacer" />
        )}
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
          items={[{ label: "Audio settings", onClick: () => navigate("/settings?section=audio") }]}
        />
      ) : null}
    </div>
  );
}
