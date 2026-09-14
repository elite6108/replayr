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
  readOnly = false,
  mirrorOf,
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
  /** Show the live mix without owning it: meters stay live, every control is inert. */
  readOnly?: boolean;
  /**
   * Take per-channel enabled state from global settings rather than from scene sources. The
   * Clips tab mirrors the live mix — which is exactly what micEnabled / gameAudioEnabled /
   * systemAudioEnabled describe — because a clip scene owns no audio sources of its own.
   */
  mirrorOf?: { mic: boolean; game: boolean; desktop: boolean };
}) {
  const mic = findSourceByType(scene, "microphone");
  const game = findSourceByType(scene, "gameAudio");
  const desktop = findSourceByType(scene, "desktopAudio");
  const micOn = mirrorOf ? mirrorOf.mic : Boolean(mic?.enabled);
  const gameOn = mirrorOf ? mirrorOf.game : Boolean(game?.enabled);
  const desktopOn = mirrorOf ? mirrorOf.desktop : Boolean(desktop?.enabled);
  const readOnlyHint = "Mixer is live for Instant Replay. Change it on the Recordings tab or in Settings.";

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
          enabled={micOn}
          peak={levels.micPeak}
          gain={settings.micGain}
          readOnly={readOnly}
          readOnlyHint={readOnlyHint}
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
          enabled={desktopOn}
          peak={levels.desktopPeak}
          gain={settings.systemAudioGain}
          readOnly={readOnly}
          readOnlyHint={readOnlyHint}
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
          enabled={gameOn}
          peak={levels.gamePeak}
          gain={settings.gameAudioGain}
          readOnly={readOnly}
          readOnlyHint={readOnlyHint}
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
