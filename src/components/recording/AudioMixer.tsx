import type { AppSettings } from "../../types/settings";
import { findSourceByType, type RecordingScene } from "../../recording/scene";
import { AudioMixerCard } from "./AudioMixerCard";

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
  onProperties,
  onRemove,
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
  onProperties: (sourceId: string) => void;
  onRemove: (sourceId: string) => void;
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
        <AudioMixerCard
          title="Microphone"
          sourceType="microphone"
          selected={selectedId === mic?.id}
          enabled={Boolean(mic?.enabled)}
          peak={levels.micPeak}
          gain={settings.micGain}
          onSelect={() => onSelect(mic?.id ?? null)}
          onToggle={onToggleMic}
          onGain={(gain) => onSave("micGain", gain)}
          onProperties={() => {
            if (mic) onProperties(mic.id);
          }}
          onRemove={() => {
            if (mic) onRemove(mic.id);
          }}
        />
        <AudioMixerCard
          title="Desktop Audio"
          sourceType="desktopAudio"
          selected={selectedId === desktop?.id}
          enabled={Boolean(desktop?.enabled)}
          peak={levels.desktopPeak}
          gain={settings.systemAudioGain}
          onSelect={() => onSelect(desktop?.id ?? null)}
          onToggle={onToggleDesktop}
          onGain={(gain) => onSave("systemAudioGain", gain)}
          onProperties={() => {
            if (desktop) onProperties(desktop.id);
          }}
          onRemove={() => {
            if (desktop) onRemove(desktop.id);
          }}
        />
        <AudioMixerCard
          title="Game Audio"
          sourceType="gameAudio"
          selected={selectedId === game?.id}
          enabled={Boolean(game?.enabled)}
          peak={levels.gamePeak}
          gain={settings.gameAudioGain}
          onSelect={() => onSelect(game?.id ?? null)}
          onToggle={onToggleGame}
          onGain={(gain) => onSave("gameAudioGain", gain)}
          onProperties={() => {
            if (game) onProperties(game.id);
          }}
          onRemove={() => {
            if (game) onRemove(game.id);
          }}
        />
      </div>
    </section>
  );
}
