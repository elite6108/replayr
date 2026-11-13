import type { AppSettings } from "../../types/settings";
import { findSourceByType, type RecordingScene, type RecordingSource } from "../../recording/scene";
import { audioForSource, fallbackAudio, sourcesOfType, type AudioGlobals, type SourceAudio } from "../../recording/sourceAudio";
import { AudioMixerCard } from "./AudioMixerCard";

export function AudioMixer({
  scene,
  settings,
  selectedId,
  levels,
  extraPeaks,
  onSelect,
  onToggleMic,
  onSetEnabled,
  onToggleGame,
  onToggleDesktop,
  onSave,
  onSourceAudio,
  onProperties,
  onInspect,
  onRemove,
  readOnly = false,
  mirrorOf,
}: {
  scene: RecordingScene;
  settings: AppSettings;
  selectedId: string | null;
  levels: { micPeak: number; gamePeak: number; desktopPeak: number };
  /** Peaks for microphones after the first, keyed by source id. */
  extraPeaks?: Readonly<Record<string, number>>;
  onSelect: (id: string | null) => void;
  onToggleMic: (enabled: boolean) => void;
  /** Mute a microphone after the first. The first microphone uses onToggleMic. */
  onSetEnabled?: (sourceId: string, enabled: boolean) => void;
  onToggleGame: (enabled: boolean) => void;
  onToggleDesktop: (enabled: boolean) => void;
  onSave: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
  /** Stores the level on the source and, for the first of its kind, on the shared settings. */
  onSourceAudio?: (sourceId: string, audio: SourceAudio) => void;
  onProperties: (sourceId: string) => void;
  onInspect?: (sourceId: string) => void;
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
  const mics = sourcesOfType(scene.sources, "microphone");
  const mic = mics[0];
  const game = findSourceByType(scene, "gameAudio");
  const desktop = findSourceByType(scene, "desktopAudio");
  const shared: AudioGlobals = {
    micGain: settings.micGain,
    microphoneId: settings.microphoneId,
    systemAudioGain: settings.systemAudioGain,
    gameAudioGain: settings.gameAudioGain,
    audioOutputId: settings.audioOutputId,
  };
  // The Clips mixer mirrors the live engine, which reads the shared levels.
  const micAudio = readOnly || !mic ? fallbackAudio("microphone", shared) : audioForSource(mic, scene.sources, shared);
  const desktopAudio = readOnly || !desktop ? fallbackAudio("desktopAudio", shared) : audioForSource(desktop, scene.sources, shared);
  const gameAudio = readOnly || !game ? fallbackAudio("gameAudio", shared) : audioForSource(game, scene.sources, shared);
  function writeAudio(source: RecordingSource | undefined, audio: SourceAudio, key: "micGain" | "systemAudioGain" | "gameAudioGain", gain: number) {
    if (source && onSourceAudio) onSourceAudio(source.id, audio);
    else onSave(key, gain);
  }
  const micOn = mirrorOf ? mirrorOf.mic : Boolean(mic?.enabled);
  const gameOn = mirrorOf ? mirrorOf.game : Boolean(game?.enabled);
  const desktopOn = mirrorOf ? mirrorOf.desktop : Boolean(desktop?.enabled);
  const readOnlyHint = "Mixer is live for Instant Replay. Change it on the Recordings tab or in Settings.";

  return (
    <section className="studio-panel studio-mixer">
      <div className="studio-block-head">
        <h2>Audio mixer</h2>
      </div>
      <div className="studio-mixer-row">
        <AudioMixerCard
          title="Microphone"
          sourceType="microphone"
          selected={selectedId === mic?.id}
          enabled={micOn}
          peak={levels.micPeak}
          gain={micAudio.gain}
          readOnly={readOnly}
          readOnlyHint={readOnlyHint}
          onSelect={() => onSelect(mic?.id ?? null)}
          onToggle={onToggleMic}
          onGain={(gain) => writeAudio(mic, { ...micAudio, gain }, "micGain", gain)}
          onProperties={() => {
            if (mic) onProperties(mic.id);
          }}
          onInspect={mic && onInspect ? () => onInspect(mic.id) : undefined}
          onRemove={() => {
            if (mic) onRemove(mic.id);
          }}
        />
        {mics.slice(1).map((extra, index) => {
          const audio = audioForSource(extra, scene.sources, shared);
          return (
            <AudioMixerCard
              key={extra.id}
              title={extra.name || `Microphone ${index + 2}`}
              sourceType="microphone"
              selected={selectedId === extra.id}
              enabled={extra.enabled}
              peak={extraPeaks?.[extra.id] ?? 0}
              gain={audio.gain}
              readOnly={readOnly}
              readOnlyHint={readOnlyHint}
              onSelect={() => onSelect(extra.id)}
              onToggle={(enabled) => onSetEnabled?.(extra.id, enabled)}
              onGain={(gain) => onSourceAudio?.(extra.id, { ...audio, gain })}
              onProperties={() => onProperties(extra.id)}
              onInspect={onInspect ? () => onInspect(extra.id) : undefined}
              onRemove={() => onRemove(extra.id)}
            />
          );
        })}
        <AudioMixerCard
          title="Desktop Audio"
          sourceType="desktopAudio"
          selected={selectedId === desktop?.id}
          enabled={desktopOn}
          peak={levels.desktopPeak}
          gain={desktopAudio.gain}
          readOnly={readOnly}
          readOnlyHint={readOnlyHint}
          onSelect={() => onSelect(desktop?.id ?? null)}
          onToggle={onToggleDesktop}
          onGain={(gain) => writeAudio(desktop, { ...desktopAudio, gain }, "systemAudioGain", gain)}
          onProperties={() => {
            if (desktop) onProperties(desktop.id);
          }}
          onInspect={desktop && onInspect ? () => onInspect(desktop.id) : undefined}
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
          gain={gameAudio.gain}
          readOnly={readOnly}
          readOnlyHint={readOnlyHint}
          onSelect={() => onSelect(game?.id ?? null)}
          onToggle={onToggleGame}
          onGain={(gain) => writeAudio(game, { ...gameAudio, gain }, "gameAudioGain", gain)}
          onProperties={() => {
            if (game) onProperties(game.id);
          }}
          onInspect={game && onInspect ? () => onInspect(game.id) : undefined}
          onRemove={() => {
            if (game) onRemove(game.id);
          }}
        />
      </div>
    </section>
  );
}
