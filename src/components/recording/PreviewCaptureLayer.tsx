import { useEffect, useRef, useState } from "react";
import { startCapturePreview, stopCapturePreview, updateCapturePreview } from "../../services/tauri";
import type { CapturePreviewHeader, CapturePreviewMode } from "../../types/capturePreview";
import type { PreviewBackgroundMode } from "../../types/settings";
import { capturePreviewFeed, useFeedCanvas } from "../../recording/previewPoll";
import { CroppedMediaFrame } from "./CroppedMediaFrame";
import type { SourceCrop } from "../../recording/scene";

export function PreviewCaptureLayer({
  mode,
  pid,
  enabled,
  fallback,
  hideBadge = false,
  monitorId = null,
  crop = null,
  filter,
  onStatus,
}: {
  mode: CapturePreviewMode;
  pid: number | null;
  enabled: boolean;
  fallback: PreviewBackgroundMode;
  hideBadge?: boolean;
  monitorId?: string | null;
  crop?: SourceCrop | null;
  /** CSS filter for the source's picture adjustments. */
  filter?: string;
  onStatus?: (status: {
    live: boolean;
    label: string;
    source: string;
    width?: number;
    height?: number;
  }) => void;
}) {
  const [frame, setFrame] = useState<CapturePreviewHeader | null>(null);
  const [live, setLive] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const target = useRef({ mode, pid, monitorId });
  target.current = { mode, pid, monitorId };

  useEffect(() => {
    if (!enabled) {
      setFrame(null);
      setLive(false);
      void stopCapturePreview();
      return;
    }
    void startCapturePreview({
      mode: target.current.mode,
      pid: target.current.pid ?? undefined,
      monitorId: target.current.monitorId,
    }).catch((caught: unknown) => {
      setFrame({
        width: 0,
        height: 0,
        state: "unavailable",
        label: caught instanceof Error ? caught.message : "Preview unavailable",
        source: "none",
        frameId: 0,
        mimeType: "image/jpeg",
      });
      setLive(false);
    });
    return () => {
      void stopCapturePreview();
    };
  }, [enabled]);

  const lastTargetKey = useRef("");
  useEffect(() => {
    if (!enabled) return;
    void updateCapturePreview({ mode, pid: pid ?? undefined, monitorId }).catch(() => undefined);
    const key = `${mode}\0${pid ?? 0}\0${monitorId ?? ""}`;
    if (lastTargetKey.current && lastTargetKey.current !== key) capturePreviewFeed.reset();
    lastTargetKey.current = key;
  }, [enabled, mode, pid, monitorId]);

  useEffect(() => {
    if (!enabled) return;
    const sync = () => {
      const current = capturePreviewFeed.state();
      if (current.header) setFrame(current.header);
      setLive(Boolean(current.bitmap));
    };
    const unsubscribe = capturePreviewFeed.subscribe(sync);
    sync();
    return unsubscribe;
  }, [enabled]);

  useFeedCanvas(capturePreviewFeed, canvasRef, enabled && live);

  const label = frame?.label ?? (mode === "desktop" ? "Desktop Preview" : "Waiting for game");
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;
  const lastStatusKey = useRef("");

  useEffect(() => {
    const width = frame && frame.width > 0 ? frame.width : 0;
    const height = frame && frame.height > 0 ? frame.height : 0;
    const source = frame?.source ?? "none";
    const key = `${live}\0${label}\0${source}\0${width}\0${height}`;
    if (lastStatusKey.current === key) return;
    lastStatusKey.current = key;
    onStatusRef.current?.({
      live,
      label,
      source,
      width: width > 0 ? width : undefined,
      height: height > 0 ? height : undefined,
    });
  }, [live, label, frame?.source, frame?.width, frame?.height]);

  const sourceAspect =
    frame && frame.width > 0 && frame.height > 0 ? frame.width / frame.height : 16 / 9;

  return (
    <div className={`preview-capture fallback-${fallback}${live ? " is-live" : ""}`}>
      {live ? (
        <CroppedMediaFrame crop={crop} sourceAspect={sourceAspect} fit="contain">
          {(mediaStyle) => <canvas ref={canvasRef} style={filter ? { ...mediaStyle, filter } : mediaStyle} />}
        </CroppedMediaFrame>
      ) : (
        <FallbackPlate mode={fallback} />
      )}
      {hideBadge ? null : <span className="preview-capture-label">{label}</span>}
    </div>
  );
}

function FallbackPlate({ mode }: { mode: PreviewBackgroundMode }) {
  if (mode === "dark") return <div className="preview-dark" />;
  return (
    <div className="preview-mock" aria-hidden="true">
      <div className="preview-mock-sky" />
      <div className="preview-mock-ridge" />
      <div className="preview-mock-ground" />
      <div className="preview-mock-road" />
      <div className="preview-mock-mark">REPLAYR</div>
    </div>
  );
}
