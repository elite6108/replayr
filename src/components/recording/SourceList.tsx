import { useState } from "react";
import { IconPlus } from "../icons";
import {
  isAudioSource,
  isVisualSource,
  moveSourceAmong,
  reorderSourceAmong,
  sourcesFrontFirst,
  type RecordingScene,
  type RecordingSourceType,
  type ScenePresetId,
} from "../../recording/scene";
import { audioPeakFor } from "../../recording/useStudioAudio";
import { AddSourceMenu } from "./AddSourceMenu";
import { AudioSourceRow } from "./AudioSourceRow";
import { VisualSourceRow } from "./VisualSourceRow";

const PRESETS: { id: ScenePresetId; label: string }[] = [
  { id: "gameplay", label: "Gameplay" },
  { id: "gameplayWebcam", label: "Gameplay + Webcam" },
  { id: "desktop", label: "Desktop" },
  { id: "blank", label: "Blank" },
];

export function SourceList({
  scene,
  selectedId,
  levels,
  settingsGain,
  onSelect,
  onToggle,
  onLock,
  onRemove,
  onAdd,
  onReorder,
  onPreset,
  compositionLocked,
}: {
  scene: RecordingScene;
  selectedId: string | null;
  levels: { micPeak: number; gamePeak: number; desktopPeak: number };
  settingsGain: { mic?: number; game?: number };
  onSelect: (id: string | null) => void;
  onToggle: (id: string, enabled: boolean) => void;
  onLock: (id: string, locked: boolean) => void;
  onRemove: (id: string) => void;
  onAdd: (type: RecordingSourceType) => void;
  onReorder: (next: RecordingScene) => void;
  onPreset: (preset: ScenePresetId) => void;
  compositionLocked?: boolean;
}) {
  const [visualMenu, setVisualMenu] = useState(false);
  const [audioMenu, setAudioMenu] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const visuals = sourcesFrontFirst(scene.sources.filter((source) => isVisualSource(source.type)));
  const audios = scene.sources.filter((source) => isAudioSource(source.type));
  const activePreset = inferPreset(scene);

  return (
    <section className="studio-panel studio-rail">
      <div className="studio-block">
        <div className="studio-block-head">
          <h2>Scenes</h2>
        </div>
        <div className="studio-scene-picker">
          <select
            aria-label="Current scene"
            value={activePreset === "custom" ? "custom" : activePreset}
            disabled={compositionLocked}
            onChange={(event) => {
              const value = event.target.value as ScenePresetId | "custom";
              if (value !== "custom") onPreset(value);
            }}
          >
            {activePreset === "custom" ? <option value="custom">{scene.name}</option> : null}
            {PRESETS.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.label}
              </option>
            ))}
          </select>
          <button type="button" className="studio-icon-btn studio-plus" title="New blank scene" disabled={compositionLocked} onClick={() => onPreset("blank")}>
            <IconPlus size={16} />
          </button>
        </div>
        <div className="studio-preset-label">Scene Presets</div>
        <div className="studio-presets">
          {PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className={`studio-preset${activePreset === preset.id ? " is-active" : ""}`}
              disabled={compositionLocked}
              onClick={() => onPreset(preset.id)}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>

      <div className={`studio-block studio-sources-block${visualMenu ? " is-menu-open" : ""}`}>
        <div className="studio-block-head">
          <h2>Visual Sources</h2>
          <button
            type="button"
            className="studio-add"
            disabled={compositionLocked}
            onClick={() => {
              setAudioMenu(false);
              setVisualMenu((open) => !open);
            }}
          >
            <IconPlus size={14} />
            Add
          </button>
        </div>
        <p className="studio-section-copy">Layers shown in the preview</p>
        <AddSourceMenu
          scene={scene}
          open={visualMenu}
          title="Add Visual Source"
          groups={["capture", "media", "overlay"]}
          onClose={() => setVisualMenu(false)}
          onAdd={onAdd}
          composed={scene.outputMode === "composed"}
        />
        {compositionLocked ? (
          <p className="studio-lock-note">Layout changes apply to the next recording.</p>
        ) : null}
        {visuals.length === 0 ? (
          <p className="studio-empty">No visual sources. Add one or pick a preset.</p>
        ) : (
          <div
            className="studio-source-list"
            onDragOver={(event) => event.preventDefault()}
            onDrop={() => {
              if (dragId) onReorder(reorderSourceAmong(scene, dragId, null, (source) => isVisualSource(source.type)));
              setDragId(null);
            }}
          >
            {visuals.map((source) => (
              <VisualSourceRow
                key={source.id}
                source={source}
                outputMode={scene.outputMode}
                selected={selectedId === source.id}
                compositionLocked={compositionLocked}
                onSelect={() => onSelect(source.id)}
                onToggle={(enabled) => onToggle(source.id, enabled)}
                onLock={(locked) => onLock(source.id, locked)}
                onMove={(direction) => onReorder(moveSourceAmong(scene, source.id, direction, (item) => isVisualSource(item.type)))}
                onRemove={() => onRemove(source.id)}
                onDragStart={() => setDragId(source.id)}
                onDrop={() => {
                  if (dragId && dragId !== source.id) {
                    onReorder(reorderSourceAmong(scene, dragId, source.id, (item) => isVisualSource(item.type)));
                  }
                  setDragId(null);
                }}
              />
            ))}
          </div>
        )}
      </div>

      <div className={`studio-block studio-audio-block${audioMenu ? " is-menu-open" : ""}`}>
        <div className="studio-block-head">
          <h2>Audio Sources</h2>
          <button
            type="button"
            className="studio-add"
            disabled={compositionLocked}
            onClick={() => {
              setVisualMenu(false);
              setAudioMenu((open) => !open);
            }}
          >
            <IconPlus size={14} />
            Add
          </button>
        </div>
        <p className="studio-section-copy">Inputs mixed into the recording</p>
        <AddSourceMenu
          scene={scene}
          open={audioMenu}
          title="Add Audio Source"
          groups={["audio"]}
          onClose={() => setAudioMenu(false)}
          onAdd={onAdd}
        />
        {audios.length === 0 ? (
          <p className="studio-empty">No audio sources in this scene.</p>
        ) : (
          <div className="studio-source-list studio-audio-list">
            {audios.map((source) => (
              <AudioSourceRow
                key={source.id}
                source={source}
                selected={selectedId === source.id}
                peak={audioPeakFor(source.type, levels)}
                gain={source.type === "microphone" ? settingsGain.mic : source.type === "gameAudio" ? settingsGain.game : undefined}
                onSelect={() => onSelect(source.id)}
                onToggle={(enabled) => onToggle(source.id, enabled)}
                onRemove={() => onRemove(source.id)}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function inferPreset(scene: RecordingScene): ScenePresetId | "custom" {
  const types = scene.sources
    .filter((source) => isVisualSource(source.type) && source.type !== "replayrOverlay")
    .map((source) => source.type)
    .sort();
  if (types.length === 0) return scene.sources.length === 0 ? "blank" : "custom";
  const key = types.join(",");
  if (key === "display") return "desktop";
  if (key === "game") return "gameplay";
  if (key === "game,webcam") return "gameplayWebcam";
  return "custom";
}
