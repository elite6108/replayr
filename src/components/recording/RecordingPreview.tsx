import { useState } from "react";
import type { CameraStatus } from "../../types/camera";
import type { RecordingVisualSettings, WebcamSettings } from "../../types/settings";
import {
  desktopCaptureSettingsOf,
  FULL_CROP,
  isCroppableSource,
  overlayToVisuals,
  primaryCapture,
  sourcesBackFirst,
  type RecordingScene,
  type RecordingSource,
  type SourceCrop,
  type SourceTransform,
} from "../../recording/scene";
import { canvasFromSettings } from "../../recording/composition";
import { sourceComposedSupported } from "../../recording/registry";
import { useDetectionStore } from "../../stores/detectionStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { PreviewCanvas } from "./PreviewCanvas";
import { PreviewCaptureLayer } from "./PreviewCaptureLayer";
import { PreviewFilterLayer } from "./PreviewFilterLayer";
import { PreviewImageLayer } from "./PreviewImageLayer";
import { PreviewOverlayLayer } from "./PreviewOverlayLayer";
import { PreviewTextLayer } from "./PreviewTextLayer";
import { PreviewTransformBox } from "./PreviewTransformBox";
import { PreviewWebcamLayer } from "./PreviewWebcamLayer";

export function RecordingPreview({
  scene,
  webcam,
  visuals,
  camera,
  quiet,
  selectedId,
  compositionLocked,
  onSelect,
  onTransform,
  onCrop,
}: {
  scene: RecordingScene;
  webcam: WebcamSettings;
  visuals: RecordingVisualSettings;
  camera: CameraStatus;
  quiet: boolean;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onTransform: (id: string, transform: SourceTransform) => void;
  onCrop?: (id: string, crop: SourceCrop) => void;
  compositionLocked?: boolean;
}) {
  const settings = useSettingsStore((state) => state.settings);
  const [preview, setPreview] = useState({
    live: false,
    label: "Preview",
    source: "none",
    width: 0,
    height: 0,
  });
  const detectedPid = useDetectionStore((state) => state.snapshot.pid);
  const primary = primaryCapture(scene);
  const previewMode = primary?.type === "display" ? "desktop" : "game";
  const previewEnabled = primary?.type !== "window";
  const composed = scene.outputMode === "composed";
  const overlay = scene.sources.find((source) => source.type === "replayrOverlay");
  const previewVisuals = overlayToVisuals(
    overlay,
    composed ? { filter: "none", overlays: { recIndicator: false, timestamp: false } } : visuals,
  );
  const composedTap = composed && preview.source === "composed";
  const layers = sourcesBackFirst(scene.sources).filter(
    (source) =>
      source.enabled &&
      source.transform &&
      (source.type === "webcam" || source.type === "image" || source.type === "text") &&
      (!composed || sourceComposedSupported(source.type)),
  );
  const selected = scene.sources.find((source) => source.id === selectedId);
  const canCrop = Boolean(
    selected &&
      isCroppableSource(selected.type) &&
      !selected.locked &&
      !compositionLocked &&
      onCrop,
  );

  const settingsCanvas = canvasFromSettings(settings);
  const settingsAspect =
    settingsCanvas.width > 0 && settingsCanvas.height > 0
      ? settingsCanvas.width / settingsCanvas.height
      : 16 / 9;
  const previewAspect =
    preview.width > 0 && preview.height > 0 ? preview.width / preview.height : settingsAspect;

  return (
    <section className="studio-panel studio-preview">
      <div className="studio-preview-head">
        <h2>{scene.outputMode === "composed" ? "Live Output Preview" : "Recording Layout Preview"}</h2>
      </div>
      <div
        className="studio-preview-stage"
        style={{ ["--preview-aspect" as string]: String(previewAspect) }}
      >
        <PreviewCanvas
          background="dark"
          safeZone={false}
          quiet={quiet}
          tune={composedTap ? "none" : previewVisuals.filter}
          plate={
            <PreviewCaptureLayer
              mode={previewMode}
              pid={detectedPid}
              enabled={previewEnabled}
              fallback="dark"
              hideBadge
              monitorId={primary?.type === "display" ? desktopCaptureSettingsOf(primary).monitorId : null}
              crop={primary?.crop ?? null}
              onStatus={(status) =>
                setPreview({
                  live: status.live,
                  label: status.label,
                  source: status.source,
                  width: status.width ?? 0,
                  height: status.height ?? 0,
                })
              }
            />
          }
        >
          <button type="button" className="preview-canvas-hit" aria-label="Select canvas" onPointerDown={() => onSelect(null)} />
          {primary &&
          selectedId === primary.id &&
          canCrop &&
          primary.transform ? (
            <PreviewTransformBox
              transform={primary.transform}
              crop={primary.crop ?? FULL_CROP}
              mode="move"
              selected
              locked={false}
              zIndex={2}
              label={primary.name}
              onSelect={() => onSelect(primary.id)}
              onTransform={(next) => onTransform(primary.id, next)}
              onCrop={(next) => onCrop?.(primary.id, next)}
            >
              {null}
            </PreviewTransformBox>
          ) : null}
          {layers.map((source, index) => (
            <PreviewTransformBox
              key={source.id}
              transform={source.transform!}
              crop={source.crop}
              mode="move"
              selected={selectedId === source.id}
              locked={source.locked || Boolean(compositionLocked)}
              zIndex={3 + index}
              label={source.name}
              onSelect={() => onSelect(source.id)}
              onTransform={(next) => onTransform(source.id, next)}
              onCrop={
                isCroppableSource(source.type) && onCrop
                  ? (next) => onCrop(source.id, next)
                  : undefined
              }
            >
              {composedTap ? null : <LayerBody source={source} webcam={webcam} camera={camera} />}
            </PreviewTransformBox>
          ))}
          {composedTap ? null : <PreviewFilterLayer filter={previewVisuals.filter} quiet={quiet} />}
          {composedTap ? null : <PreviewOverlayLayer filter={previewVisuals.filter} overlays={previewVisuals.overlays} />}
        </PreviewCanvas>
        {compositionLocked ? (
          <p className="studio-lock-note">Layout changes apply to the next recording.</p>
        ) : null}
      </div>
    </section>
  );
}

function LayerBody({
  source,
  webcam,
  camera,
}: {
  source: RecordingSource;
  webcam: WebcamSettings;
  camera: CameraStatus;
}) {
  if (source.type === "webcam") {
    return <PreviewWebcamLayer webcam={webcam} camera={camera} source={source} framed />;
  }
  if (source.type === "image") {
    return <PreviewImageLayer source={source} />;
  }
  return <PreviewTextLayer source={source} />;
}
