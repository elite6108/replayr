import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { CameraStatus } from "../../types/camera";
import type { RecordingVisualSettings, WebcamSettings } from "../../types/settings";
import {
  desktopCaptureSettingsOf,
  FULL_CROP,
  isCroppableSource,
  isPrimaryCapture,
  overlayToVisuals,
  primaryCapture,
  sourcesBackFirst,
  type RecordingScene,
  type RecordingSource,
  type SourceCrop,
  type SourceTransform,
} from "../../recording/scene";
import type { StudioMode } from "../../recording/studioMode";
import { samePreviewStatus, canvasFromAspect, type PreviewStatusFields } from "../../recording/previewCanvas";
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
  studio = "recording",
  onSelect,
  onTransform,
  onCrop,
  fitOutputCanvas = false,
  onGestureStart,
  onGestureEnd,
  onGestureCancel,
  outputWidth = 0,
  outputHeight = 0,
  onFrameSize,
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
  studio?: StudioMode;
  /** Recordings studio only. Clips keep the stretched stage. */
  fitOutputCanvas?: boolean;
  onGestureStart?: (id: string) => void;
  onGestureEnd?: () => void;
  onGestureCancel?: () => void;
  outputWidth?: number;
  outputHeight?: number;
  onFrameSize?: (width: number, height: number) => void;
}) {
  const settings = useSettingsStore((state) => state.settings);
  const [preview, setPreview] = useState<PreviewStatusFields>({
    live: false,
    label: "Preview",
    source: "none",
    width: 0,
    height: 0,
  });
  const reportStatus = useCallback((status: { live: boolean; label: string; source: string; width?: number; height?: number }) => {
    setPreview((prev) => {
      const next: PreviewStatusFields = {
        live: status.live,
        label: status.label,
        source: status.source,
        width: status.width ?? 0,
        height: status.height ?? 0,
      };
      return samePreviewStatus(prev, next) ? prev : next;
    });
    onFrameSize?.(status.width ?? 0, status.height ?? 0);
  }, [onFrameSize]);
  const stageRef = useRef<HTMLDivElement>(null);
  const [stageBox, setStageBox] = useState({ w: 0, h: 0 });
  useEffect(() => {
    if (!fitOutputCanvas) return;
    const node = stageRef.current;
    if (!node) return;
    const measure = () => {
      const rect = node.getBoundingClientRect();
      setStageBox((prev) => (prev.w === rect.width && prev.h === rect.height ? prev : { w: rect.width, h: rect.height }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [fitOutputCanvas]);
  const detectedPid = useDetectionStore((state) => state.snapshot.pid);
  const primary = primaryCapture(scene);
  const captureEnabled = Boolean(primary?.enabled && primary.type !== "window");
  const previewMode = primary?.type === "display" ? "desktop" : "game";
  const composed = scene.outputMode === "composed";
  const overlay = scene.sources.find((source) => source.type === "replayrOverlay");
  const previewVisuals = overlayToVisuals(
    overlay,
    composed ? { filter: "none", overlays: { recIndicator: false, timestamp: false } } : visuals,
  );
  const composedTap = fitOutputCanvas && composed && preview.source === "composed";
  const showCapturePlate = !fitOutputCanvas || composedTap;
  const ordered = sourcesBackFirst(scene.sources).filter((source) => source.enabled && source.transform);
  const videoLayers = fitOutputCanvas && !composedTap
    ? ordered.filter(
        (source) =>
          (isPrimaryCapture(source.type) && source.type !== "window") ||
          (source.type === "webcam" && (!composed || sourceComposedSupported(source.type))),
      )
    : [];
  const stillLayers = (fitOutputCanvas ? ordered : ordered).filter(
    (source) =>
      (source.type === "webcam" || source.type === "image" || source.type === "text") &&
      (!composed || sourceComposedSupported(source.type)) &&
      !(fitOutputCanvas && !composedTap && source.type === "webcam"),
  );
  const clipLayers = fitOutputCanvas
    ? []
    : ordered.filter(
        (source) =>
          (source.type === "webcam" || source.type === "image" || source.type === "text") &&
          (!composed || sourceComposedSupported(source.type)),
      );
  const selected = scene.sources.find((source) => source.id === selectedId);
  const canCrop = Boolean(
    selected && isCroppableSource(selected.type) && !selected.locked && !compositionLocked && onCrop,
  );
  const aspect = preview.width > 1 && preview.height > 1 ? preview.width / preview.height : null;
  const logical =
    outputWidth >= 2 && outputHeight >= 2
      ? { width: outputWidth, height: outputHeight }
      : aspect
        ? canvasFromAspect(aspect, settings.resolution)
        : canvasFromAspect(16 / 9, settings.resolution);
  const scale =
    fitOutputCanvas && stageBox.w > 0 && stageBox.h > 0
      ? Math.min(stageBox.w / logical.width, stageBox.h / logical.height)
      : 1;
  const legacyDisplay = fitOutputCanvas && !composed && primary?.type === "display";

  const capturePlate = (
    <PreviewCaptureLayer
      mode={previewMode}
      pid={detectedPid}
      enabled={showCapturePlate ? (fitOutputCanvas ? true : primary?.type !== "window") : captureEnabled}
      fallback="dark"
      hideBadge
      monitorId={primary?.type === "display" ? desktopCaptureSettingsOf(primary).monitorId : null}
      crop={composedTap || !showCapturePlate ? null : (primary?.crop ?? null)}
      onStatus={reportStatus}
    />
  );

  function renderLayer(source: RecordingSource, zIndex: number) {
    return (
      <PreviewTransformBox
        key={source.id}
        transform={source.transform!}
        crop={source.crop}
        mode="move"
        selected={selectedId === source.id}
        locked={source.locked || Boolean(compositionLocked)}
        zIndex={zIndex}
        label={source.name}
        onSelect={() => onSelect(source.id)}
        onTransform={(next) => onTransform(source.id, next)}
        onCrop={isCroppableSource(source.type) && onCrop ? (next) => onCrop(source.id, next) : undefined}
        onGestureStart={fitOutputCanvas ? () => onGestureStart?.(source.id) : undefined}
        onGestureEnd={fitOutputCanvas ? onGestureEnd : undefined}
        onGestureCancel={fitOutputCanvas ? onGestureCancel : undefined}
      >
        {composedTap ? null : (
          <LayerBody
            source={source}
            webcam={webcam}
            camera={camera}
            recorded={fitOutputCanvas}
            capture={
              isPrimaryCapture(source.type) ? (
                <PreviewCaptureLayer
                  mode={previewMode}
                  pid={detectedPid}
                  enabled={captureEnabled}
                  fallback="dark"
                  hideBadge
                  monitorId={primary?.type === "display" ? desktopCaptureSettingsOf(primary).monitorId : null}
                  crop={source.crop ?? null}
                  onStatus={reportStatus}
                />
              ) : null
            }
          />
        )}
      </PreviewTransformBox>
    );
  }

  const canvas = (
    <PreviewCanvas
      background="dark"
      safeZone={false}
      quiet={quiet}
      tune={composedTap ? "none" : previewVisuals.filter}
      plate={showCapturePlate ? capturePlate : <div className="preview-dark" />}
    >
      <button type="button" className="preview-canvas-hit" aria-label="Select canvas" onPointerDown={() => onSelect(null)} />
      {!fitOutputCanvas && primary && selectedId === primary.id && canCrop && primary.transform ? (
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
      {(fitOutputCanvas ? [] : clipLayers).map((source, index) => (
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
          onCrop={isCroppableSource(source.type) && onCrop ? (next) => onCrop(source.id, next) : undefined}
        >
          {composedTap ? null : <LayerBody source={source} webcam={webcam} camera={camera} />}
        </PreviewTransformBox>
      ))}
      {fitOutputCanvas && !composedTap
        ? videoLayers.map((source, index) => renderLayer(source, 2 + index))
        : null}
      {fitOutputCanvas && !composedTap
        ? stillLayers.map((source, index) => renderLayer(source, 20 + index))
        : null}
      {composedTap ? null : <PreviewFilterLayer filter={previewVisuals.filter} quiet={quiet} />}
      {composedTap ? null : (
        <PreviewOverlayLayer filter={previewVisuals.filter} overlays={previewVisuals.overlays} recorded={fitOutputCanvas} />
      )}
    </PreviewCanvas>
  );

  return (
    <section className="studio-panel studio-preview">
      <div className="studio-preview-head">
        <h2>
          {studio === "clip"
            ? "Clip Layout Preview"
            : scene.outputMode === "composed"
              ? "Live Output Preview"
              : "Recording Layout Preview"}
        </h2>
      </div>
      <div
        ref={stageRef}
        className={`studio-preview-stage${fitOutputCanvas ? " is-output-canvas" : ""}`}
        style={{ ["--preview-scale" as string]: String(scale || 1) }}
      >
        {fitOutputCanvas ? (
          <div className="preview-output-fit" style={{ width: logical.width * scale, height: logical.height * scale }}>
            <div
              className="preview-output-scale"
              style={{ width: logical.width, height: logical.height, transform: `scale(${scale})`, transformOrigin: "top left" }}
            >
              {canvas}
            </div>
          </div>
        ) : (
          canvas
        )}
        {legacyDisplay ? (
          <p className="studio-lock-note">
            Legacy records the detected game, or the primary display if no game is running. It does not record this monitor. Use Composed to record this layout.
          </p>
        ) : null}
        {compositionLocked ? <p className="studio-lock-note">Stop recording to edit layout.</p> : null}
      </div>
    </section>
  );
}

function LayerBody({
  source,
  webcam,
  camera,
  recorded = false,
  capture = null,
}: {
  source: RecordingSource;
  webcam: WebcamSettings;
  camera: CameraStatus;
  recorded?: boolean;
  capture?: ReactNode;
}) {
  if (isPrimaryCapture(source.type)) return capture;
  if (source.type === "webcam") {
    return (
      <PreviewWebcamLayer
        webcam={webcam}
        camera={camera}
        source={source}
        framed
        mirror={recorded ? webcam.mirrorRecording : webcam.mirrorPreview}
      />
    );
  }
  if (source.type === "image") return <PreviewImageLayer source={source} />;
  return <PreviewTextLayer source={source} recorded={recorded} />;
}
