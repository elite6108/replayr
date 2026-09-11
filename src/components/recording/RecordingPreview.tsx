import { useEffect, useState } from "react";
import type { CameraStatus } from "../../types/camera";
import type { PreviewBackgroundMode, RecordingVisualSettings, WebcamSettings } from "../../types/settings";
import { IconCenter, IconFit, IconReset, IconSafeArea } from "../icons";
import {
  defaultTransform,
  desktopCaptureSettingsOf,
  FULL_CROP,
  isCroppableSource,
  overlayToVisuals,
  primaryCapture,
  sourcesBackFirst,
  transformCenter,
  transformFit,
  type RecordingScene,
  type RecordingSource,
  type SourceCrop,
  type SourceTransform,
} from "../../recording/scene";
import { sourceComposedSupported } from "../../recording/registry";
import { useDetectionStore } from "../../stores/detectionStore";
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
  const [background, setBackground] = useState<PreviewBackgroundMode>("dark");
  const [safeZone, setSafeZone] = useState(false);
  const [editMode, setEditMode] = useState<"move" | "crop">("move");
  const [preview, setPreview] = useState({ live: false, label: "Preview", source: "none" });
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
  const canLayout = Boolean(selected?.transform && !selected.locked && !compositionLocked);
  const canCrop = Boolean(
    selected &&
      isCroppableSource(selected.type) &&
      !selected.locked &&
      !compositionLocked &&
      onCrop,
  );

  useEffect(() => {
    if (!canCrop && editMode === "crop") setEditMode("move");
  }, [canCrop, editMode]);

  useEffect(() => {
    setEditMode("move");
  }, [selectedId]);

  return (
    <section className="studio-panel studio-preview">
      <div className="studio-preview-head">
        <h2>{scene.outputMode === "composed" ? "Live Output Preview" : "Recording Layout Preview"}</h2>
      </div>
      <div className="studio-preview-stage">
        <PreviewCanvas
          background={background}
          safeZone={safeZone}
          quiet={quiet}
          plate={
            <PreviewCaptureLayer
              mode={previewMode}
              pid={detectedPid}
              enabled={previewEnabled}
              fallback={background}
              hideBadge
              monitorId={primary?.type === "display" ? desktopCaptureSettingsOf(primary).monitorId : null}
              crop={primary?.crop ?? null}
              onStatus={setPreview}
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
              mode={editMode === "crop" ? "crop" : "move"}
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
              mode={selectedId === source.id && editMode === "crop" && isCroppableSource(source.type) ? "crop" : "move"}
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
      <div className="studio-preview-toolbar">
        <button
          type="button"
          className="studio-tool"
          disabled={!canLayout || editMode === "crop"}
          onClick={() => selected?.transform && onTransform(selected.id, transformFit(selected.transform))}
        >
          <IconFit size={14} />
          Fit
        </button>
        <button
          type="button"
          className="studio-tool"
          disabled={!canLayout || editMode === "crop"}
          onClick={() => selected?.transform && onTransform(selected.id, transformCenter(selected.transform))}
        >
          <IconCenter size={14} />
          Center
        </button>
        <button
          type="button"
          className={`studio-tool${editMode === "crop" ? " is-on" : ""}`}
          disabled={!canCrop}
          onClick={() => setEditMode((mode) => (mode === "crop" ? "move" : "crop"))}
        >
          Crop
        </button>
        <button
          type="button"
          className="studio-tool"
          disabled={!canLayout && !canCrop}
          onClick={() => {
            if (!selected) return;
            if (editMode === "crop" && onCrop && isCroppableSource(selected.type)) {
              onCrop(selected.id, { ...FULL_CROP });
              return;
            }
            onTransform(
              selected.id,
              defaultTransform(selected.type, webcam) ??
                selected.transform ??
                transformCenter({ x: 0, y: 0, w: 1, h: 1 }),
            );
          }}
        >
          <IconReset size={14} />
          Reset
        </button>
        <button type="button" className={`studio-tool${safeZone ? " is-on" : ""}`} onClick={() => setSafeZone((open) => !open)}>
          <IconSafeArea size={14} />
          Safe Area
        </button>
        {import.meta.env.DEV ? (
          <details className="studio-debug">
            <summary>Dev</summary>
            <button type="button" className="studio-chip" onClick={() => setBackground("mock")}>
              Mock
            </button>
            <button type="button" className="studio-chip" onClick={() => setBackground("dark")}>
              Dark
            </button>
          </details>
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
