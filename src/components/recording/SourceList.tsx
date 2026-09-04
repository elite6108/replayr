import { useState, type PointerEvent as ReactPointerEvent } from "react";
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
import { ScenePicker } from "./ScenePicker";
import { VisualSourceRow } from "./VisualSourceRow";

export function SourceList({
  scene,
  scenes,
  selectedId,
  levels,
  settingsGain,
  onSelect,
  onToggle,
  onLock,
  onRemove,
  onAdd,
  onReorder,
  onSelectScene,
  onCreateScene,
  onRenameScene,
  onDuplicateScene,
  onDeleteScene,
  onProperties,
  compositionLocked,
}: {
  scene: RecordingScene;
  scenes: RecordingScene[];
  selectedId: string | null;
  levels: { micPeak: number; gamePeak: number; desktopPeak: number };
  settingsGain: { mic?: number; game?: number };
  onSelect: (id: string | null) => void;
  onToggle: (id: string, enabled: boolean) => void;
  onLock: (id: string, locked: boolean) => void;
  onRemove: (id: string) => void;
  onAdd: (type: RecordingSourceType) => void;
  onReorder: (next: RecordingScene) => void;
  onSelectScene: (id: string) => void;
  onCreateScene: (name: string, template: ScenePresetId | null) => void;
  onRenameScene: (id: string, name: string) => void;
  onDuplicateScene: (id: string) => void;
  onDeleteScene: (id: string) => void;
  onProperties: (id: string) => void;
  compositionLocked?: boolean;
}) {
  const [visualMenu, setVisualMenu] = useState(false);
  const [audioMenu, setAudioMenu] = useState(false);
  const [drag, setDrag] = useState<{ id: string; overId: string | null } | null>(null);
  const visuals = sourcesFrontFirst(scene.sources.filter((source) => isVisualSource(source.type)));
  const audios = scene.sources.filter((source) => isAudioSource(source.type));

  function beginReorder(id: string, event: ReactPointerEvent<HTMLElement>) {
    if (compositionLocked) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ id, overId: id });
    const onMove = (moveEvent: PointerEvent) => {
      setDrag({ id, overId: hitVisualSource(moveEvent.clientY) });
    };
    const onUp = (upEvent: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      const overId = hitVisualSource(upEvent.clientY);
      if (overId !== id) {
        onReorder(reorderSourceAmong(scene, id, overId, (source) => isVisualSource(source.type)));
      }
      setDrag(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  return (
    <section className="studio-panel studio-rail">
      <div className="studio-block">
        <div className="studio-block-head">
          <h2>Scenes</h2>
        </div>
        <ScenePicker
          scenes={scenes}
          activeId={scene.id}
          locked={Boolean(compositionLocked)}
          onSelect={onSelectScene}
          onCreate={onCreateScene}
          onRename={onRenameScene}
          onDuplicate={onDuplicateScene}
          onDelete={onDeleteScene}
        />
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
        <p className="studio-section-copy">Top of the list is in front</p>
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
          <p className="studio-empty">No visual sources. Add one or create a scene.</p>
        ) : (
          <div className="studio-source-list">
            {visuals.map((source) => (
              <VisualSourceRow
                key={source.id}
                source={source}
                outputMode={scene.outputMode}
                selected={selectedId === source.id}
                compositionLocked={compositionLocked}
                dropBefore={Boolean(drag && drag.id !== source.id && drag.overId === source.id)}
                onSelect={() => onSelect(source.id)}
                onToggle={(enabled) => onToggle(source.id, enabled)}
                onLock={(locked) => onLock(source.id, locked)}
                onMove={(direction) => onReorder(moveSourceAmong(scene, source.id, direction, (item) => isVisualSource(item.type)))}
                onRemove={() => onRemove(source.id)}
                onProperties={() => onProperties(source.id)}
                onRename={() => {
                  onSelect(source.id);
                  window.requestAnimationFrame(() => document.getElementById("record-source-name")?.focus());
                }}
                onGripDown={(event) => beginReorder(source.id, event)}
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

function hitVisualSource(clientY: number): string | null {
  const rows = [...document.querySelectorAll<HTMLElement>("[data-visual-source-id]")];
  for (const row of rows) {
    const rect = row.getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) return row.dataset.visualSourceId ?? null;
  }
  return null;
}
