import type { CameraDevice, CameraStatus } from "../../types/camera";
import type { AppSettings, WebcamPlacement, WebcamShape } from "../../types/settings";
import { DEFAULT_WEBCAM_SETTINGS } from "../../types/settings";
import { RecordingVisualControls } from "./RecordingVisualControls";
import {
  clampTransform,
  defaultTransform,
  isAudioSource,
  overlayToVisuals,
  placementToTransform,
  transformCenter,
  transformFill,
  transformFit,
  type RecordingSource,
  type SourceTransform,
} from "../../recording/scene";
import { audioPeakFor } from "../../recording/useStudioAudio";
import { AudioSourceSettings } from "./sources/AudioSourceSettings";
import type { DisplayInfo } from "../../recording/display/displayTypes";
import { DisplaySourceSettings } from "./sources/DisplaySourceSettings";
import { GameSourceSettings } from "./sources/GameSourceSettings";
import { ImageSourceSettings } from "./sources/ImageSourceSettings";
import { TextSourceSettings } from "./sources/TextSourceSettings";
import { WebcamSourceSettings } from "./sources/WebcamSourceSettings";

export function SourceInspector({
  source,
  settings,
  camera,
  levels,
  onSaveSetting,
  onPatch,
  onToggle,
  onTransform,
  onWebcamDevice,
  compositionLocked,
  composed,
  displays,
  listError,
  recording,
}: {
  source: RecordingSource | null;
  settings: AppSettings;
  camera: CameraStatus;
  levels: { micPeak: number; gamePeak: number; desktopPeak: number };
  onSaveSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
  onPatch: (id: string, patch: { name?: string; settings?: Record<string, unknown>; transform?: SourceTransform | null; locked?: boolean }) => void;
  onToggle: (id: string, enabled: boolean) => void;
  onTransform: (id: string, transform: SourceTransform) => void;
  onWebcamDevice: (device: CameraDevice) => void;
  compositionLocked?: boolean;
  composed?: boolean;
  displays?: DisplayInfo[];
  listError?: string | null;
  recording?: boolean;
}) {
  return (
    <section className="studio-panel studio-inspector">
      <div className="studio-block-head">
        <h2>Inspector</h2>
      </div>
      {compositionLocked ? (
        <p className="studio-lock-note">Layout changes apply to the next recording.</p>
      ) : null}
      {!source ? (
        <p className="studio-empty">Select a source to edit it.</p>
      ) : (
        <div className="studio-inspector-body">
          <fieldset className="studio-inspector-fields" disabled={compositionLocked}>
          <div className="studio-inspector-title">
            <input
              id="record-source-name"
              type="text"
              value={source.name}
              onChange={(event) => onPatch(source.id, { name: event.target.value })}
            />
            <label className="studio-switch">
              <span className="visually-hidden">Enabled</span>
              <input className="switch" type="checkbox" checked={source.enabled} onChange={(event) => onToggle(source.id, event.target.checked)} />
            </label>
          </div>
          <InspectorBody
            source={source}
            settings={settings}
            camera={camera}
            levels={levels}
            onSaveSetting={onSaveSetting}
            onPatch={onPatch}
            onToggle={onToggle}
            onWebcamDevice={onWebcamDevice}
            composed={composed}
            displays={displays}
            listError={listError}
            recording={recording}
          />
          {source.transform && !isAudioSource(source.type) ? (
            <TransformSection
              source={source}
              settings={settings}
              onTransform={(next) => onTransform(source.id, next)}
            />
          ) : null}
          </fieldset>
        </div>
      )}
    </section>
  );
}

function InspectorBody({
  source,
  settings,
  camera,
  levels,
  onSaveSetting,
  onPatch,
  onToggle,
  onWebcamDevice,
  composed,
  displays,
  listError,
  recording,
}: {
  source: RecordingSource;
  settings: AppSettings;
  camera: CameraStatus;
  levels: { micPeak: number; gamePeak: number; desktopPeak: number };
  onSaveSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
  onPatch: (id: string, patch: { settings?: Record<string, unknown>; transform?: SourceTransform | null }) => void;
  onToggle: (id: string, enabled: boolean) => void;
  onWebcamDevice: (device: CameraDevice) => void;
  composed?: boolean;
  displays?: DisplayInfo[];
  listError?: string | null;
  recording?: boolean;
}) {
  if (source.type === "game") {
    return <GameSourceSettings settings={settings} onSave={onSaveSetting} />;
  }
  if (source.type === "display") {
    return (
      <DisplaySourceSettings
        source={source}
        displays={displays ?? []}
        listError={listError}
        recording={Boolean(recording)}
        onMonitorId={(monitorId) => onPatch(source.id, { settings: { monitorId } })}
      />
    );
  }
  if (source.type === "window") {
    return <p className="studio-empty">Coming later. Window capture is not available yet.</p>;
  }
  if (source.type === "webcam") {
    return (
      <WebcamSourceSettings
        source={source}
        webcam={settings.webcam}
        camera={camera}
        onToggle={(enabled) => onToggle(source.id, enabled)}
        onShape={(shape: WebcamShape) => onPatch(source.id, { settings: { shape } })}
        onSnap={(placement: WebcamPlacement) =>
          onPatch(source.id, {
            transform: placementToTransform(placement, settings.webcam.defaultWidth || DEFAULT_WEBCAM_SETTINGS.defaultWidth),
          })
        }
        onDevice={onWebcamDevice}
        onMirror={(mirrorRecording) => onSaveSetting("webcam", { ...settings.webcam, mirrorRecording })}
      />
    );
  }
  if (source.type === "image") {
    return <ImageSourceSettings source={source} onChange={(next) => onPatch(source.id, { settings: next })} />;
  }
  if (source.type === "text") {
    return <TextSourceSettings source={source} onChange={(next) => onPatch(source.id, { settings: next })} />;
  }
  if (source.type === "microphone" || source.type === "desktopAudio" || source.type === "gameAudio") {
    return (
      <AudioSourceSettings
        source={source}
        peak={audioPeakFor(source.type, levels)}
        gain={source.type === "microphone" ? settings.micGain : source.type === "gameAudio" ? settings.gameAudioGain : undefined}
        onToggle={(enabled) => onToggle(source.id, enabled)}
        onGain={
          source.type === "microphone"
            ? (gain) => onSaveSetting("micGain", gain)
            : source.type === "gameAudio"
              ? (gain) => onSaveSetting("gameAudioGain", gain)
              : undefined
        }
      />
    );
  }
  if (source.type === "replayrOverlay") {
    const visuals = overlayToVisuals(source, settings.recordingVisuals);
    return (
      <details className="studio-fold" open>
        <summary>Filters</summary>
        <RecordingVisualControls
          visuals={visuals}
          composed={composed}
          onChange={async (next) => {
            onPatch(source.id, { settings: overlaySettingsFromVisuals(next) });
          }}
        />
      </details>
    );
  }
  return <p className="studio-empty">Coming later.</p>;
}

function TransformSection({
  source,
  settings,
  onTransform,
}: {
  source: RecordingSource;
  settings: AppSettings;
  onTransform: (transform: SourceTransform) => void;
}) {
  const transform = source.transform!;
  const fit = transform.w >= 0.98 && transform.h >= 0.98 ? "cover" : "contain";

  function patch(partial: Partial<SourceTransform>) {
    onTransform(clampTransform({ ...transform, ...partial }));
  }

  return (
    <div className="studio-section">
      <h3>Transform</h3>
      <div className="studio-xy">
        <label>
          Position
          <span>
            <em>X</em>
            <input
              type="number"
              min={0}
              max={100}
              step={0.5}
              disabled={source.locked}
              value={toPct(transform.x)}
              onChange={(event) => patch({ x: fromPct(event.target.value) })}
            />
          </span>
          <span>
            <em>Y</em>
            <input
              type="number"
              min={0}
              max={100}
              step={0.5}
              disabled={source.locked}
              value={toPct(transform.y)}
              onChange={(event) => patch({ y: fromPct(event.target.value) })}
            />
          </span>
        </label>
        <label>
          Size
          <span>
            <em>W</em>
            <input
              type="number"
              min={6}
              max={100}
              step={0.5}
              disabled={source.locked}
              value={toPct(transform.w)}
              onChange={(event) => patch({ w: fromPct(event.target.value) })}
            />
          </span>
          <span>
            <em>H</em>
            <input
              type="number"
              min={6}
              max={100}
              step={0.5}
              disabled={source.locked}
              value={toPct(transform.h)}
              onChange={(event) => patch({ h: fromPct(event.target.value) })}
            />
          </span>
        </label>
      </div>
      <div className="field">
        <label htmlFor="record-source-fit">Fit</label>
        <select
          id="record-source-fit"
          disabled={source.locked}
          value={fit}
          onChange={(event) => onTransform(event.target.value === "cover" ? transformFill() : transformFit(transform))}
        >
          <option value="contain">Contain</option>
          <option value="cover">Cover</option>
        </select>
      </div>
      <button
        type="button"
        className="btn ghost sm studio-reset"
        disabled={source.locked}
        onClick={() => onTransform(defaultTransform(source.type, settings.webcam) ?? transformCenter(transform))}
      >
        Reset Transform
      </button>
    </div>
  );
}

function overlaySettingsFromVisuals(visuals: AppSettings["recordingVisuals"]) {
  return {
    filter: visuals.filter,
    recIndicator: visuals.overlays.recIndicator,
    timestamp: visuals.overlays.timestamp,
  };
}

function toPct(value: number) {
  return Math.round(value * 1000) / 10;
}

function fromPct(value: string) {
  return Number(value) / 100;
}
