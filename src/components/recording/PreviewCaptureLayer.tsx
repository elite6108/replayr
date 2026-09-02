import { useEffect, useRef, useState } from "react";
import {
  getCapturePreviewFrame,
  startCapturePreview,
  stopCapturePreview,
  updateCapturePreview,
} from "../../services/tauri";
import type { CapturePreviewFrame, CapturePreviewMode } from "../../types/capturePreview";
import type { PreviewBackgroundMode } from "../../types/settings";

export function PreviewCaptureLayer({
  mode,
  pid,
  enabled,
  fallback,
  hideBadge = false,
  onStatus,
}: {
  mode: CapturePreviewMode;
  pid: number | null;
  enabled: boolean;
  fallback: PreviewBackgroundMode;
  hideBadge?: boolean;
  onStatus?: (status: { live: boolean; label: string }) => void;
}) {
  const [frame, setFrame] = useState<CapturePreviewFrame | null>(null);
  const inflight = useRef(false);
  const target = useRef({ mode, pid });
  target.current = { mode, pid };

  useEffect(() => {
    if (!enabled) {
      setFrame(null);
      void stopCapturePreview();
      return;
    }
    void startCapturePreview({ mode: target.current.mode, pid: target.current.pid ?? undefined }).catch((caught: unknown) => {
      setFrame({
        pngBase64: null,
        width: 0,
        height: 0,
        state: "unavailable",
        label: caught instanceof Error ? caught.message : "Preview unavailable",
        source: "none",
      });
    });
    return () => {
      void stopCapturePreview();
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    void updateCapturePreview({ mode, pid: pid ?? undefined }).catch(() => undefined);
  }, [enabled, mode, pid]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const pull = () => {
      if (inflight.current) return;
      inflight.current = true;
      void getCapturePreviewFrame()
        .then((next) => {
          if (!cancelled && next) setFrame(normalizeFrame(next));
        })
        .catch(() => undefined)
        .finally(() => {
          inflight.current = false;
        });
    };
    pull();
    const timer = window.setInterval(pull, 80);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [enabled]);

  const png = frame?.pngBase64;
  const live = Boolean(png);
  const label = frame?.label ?? (mode === "desktop" ? "Desktop Preview" : "Waiting for game");

  useEffect(() => {
    onStatus?.({ live, label });
  }, [live, label, onStatus]);

  return (
    <div className={`preview-capture fallback-${fallback}${live ? " is-live" : ""}`}>
      {live ? <img src={`data:image/png;base64,${png}`} alt="" draggable={false} /> : <FallbackPlate mode={fallback} />}
      {hideBadge ? null : <span className="preview-capture-label">{label}</span>}
    </div>
  );
}

function normalizeFrame(frame: CapturePreviewFrame & { png_base64?: string | null }): CapturePreviewFrame {
  return {
    ...frame,
    pngBase64: frame.pngBase64 ?? frame.png_base64 ?? null,
  };
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
