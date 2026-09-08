import { useEffect, useRef, useState } from "react";
import {
  getCapturePreviewFrame,
  startCapturePreview,
  stopCapturePreview,
  updateCapturePreview,
} from "../../services/tauri";
import type { CapturePreviewFrame, CapturePreviewMode } from "../../types/capturePreview";
import type { PreviewBackgroundMode, PreviewQuality } from "../../types/settings";
import { useSettingsStore } from "../../stores/settingsStore";
import {
  createPreviewDiag,
  decodePreviewDataUrl,
  logPreviewDiag,
  notePreviewTiming,
  startPreviewPollLoop,
} from "../../recording/previewPoll";

function previewPollMs(quality: PreviewQuality): number {
  return quality === "performance" ? 40 : 33;
}

export function PreviewCaptureLayer({
  mode,
  pid,
  enabled,
  fallback,
  hideBadge = false,
  monitorId = null,
  onStatus,
}: {
  mode: CapturePreviewMode;
  pid: number | null;
  enabled: boolean;
  fallback: PreviewBackgroundMode;
  hideBadge?: boolean;
  monitorId?: string | null;
  onStatus?: (status: { live: boolean; label: string; source: string }) => void;
}) {
  const previewQuality = useSettingsStore((state) => state.settings.previewQuality);
  const [frame, setFrame] = useState<CapturePreviewFrame | null>(null);
  const [displaySrc, setDisplaySrc] = useState("");
  const lastFrameId = useRef(0);
  const diag = useRef(createPreviewDiag());
  const target = useRef({ mode, pid, monitorId });
  target.current = { mode, pid, monitorId };

  useEffect(() => {
    if (!enabled) {
      setFrame(null);
      setDisplaySrc("");
      lastFrameId.current = 0;
      void stopCapturePreview();
      return;
    }
    void startCapturePreview({
      mode: target.current.mode,
      pid: target.current.pid ?? undefined,
      monitorId: target.current.monitorId,
    }).catch((caught: unknown) => {
      setFrame({
        pngBase64: null,
        width: 0,
        height: 0,
        state: "unavailable",
        label: caught instanceof Error ? caught.message : "Preview unavailable",
        source: "none",
        frameId: 0,
        mimeType: "image/jpeg",
      });
      setDisplaySrc("");
    });
    return () => {
      void stopCapturePreview();
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    void updateCapturePreview({ mode, pid: pid ?? undefined, monitorId }).catch(() => undefined);
  }, [enabled, mode, pid, monitorId]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const stop = startPreviewPollLoop({
      intervalMs: previewPollMs(previewQuality),
      cancelled: () => cancelled,
      pull: async () => {
        const ipcStarted = performance.now();
        const nextRaw = await getCapturePreviewFrame();
        const ipcMs = performance.now() - ipcStarted;
        if (cancelled || !nextRaw) return;
        const next = normalizeFrame(nextRaw);
        diag.current.offered += 1;
        const frameId = next.frameId || 0;
        if (frameId !== 0 && frameId === lastFrameId.current) {
          diag.current.duplicatesSkipped += 1;
          notePreviewTiming(diag.current, ipcMs, 0);
          logPreviewDiag("capture", diag.current, {
            width: next.width,
            height: next.height,
            mimeType: next.mimeType,
          });
          return;
        }
        if (!next.pngBase64) {
          lastFrameId.current = frameId;
          setFrame(next);
          setDisplaySrc("");
          diag.current.rendered += 1;
          notePreviewTiming(diag.current, ipcMs, 0);
          return;
        }
        const presentStarted = performance.now();
        const url = await decodePreviewDataUrl(next.pngBase64, next.mimeType || "image/jpeg");
        const presentMs = performance.now() - presentStarted;
        if (cancelled) return;
        lastFrameId.current = frameId;
        setFrame(next);
        setDisplaySrc(url);
        diag.current.rendered += 1;
        notePreviewTiming(diag.current, ipcMs, presentMs);
        logPreviewDiag("capture", diag.current, {
          width: next.width,
          height: next.height,
          frameId,
          mimeType: next.mimeType,
        });
      },
    });
    return () => {
      cancelled = true;
      stop();
    };
  }, [enabled, previewQuality]);

  const live = Boolean(displaySrc);
  const label = frame?.label ?? (mode === "desktop" ? "Desktop Preview" : "Waiting for game");

  useEffect(() => {
    onStatus?.({ live, label, source: frame?.source ?? "none" });
  }, [live, label, frame?.source, onStatus]);

  return (
    <div className={`preview-capture fallback-${fallback}${live ? " is-live" : ""}`}>
      {live ? <img src={displaySrc} alt="" draggable={false} /> : <FallbackPlate mode={fallback} />}
      {hideBadge ? null : <span className="preview-capture-label">{label}</span>}
    </div>
  );
}

function normalizeFrame(
  frame: CapturePreviewFrame & {
    png_base64?: string | null;
    frame_id?: number;
    mime_type?: string;
  },
): CapturePreviewFrame {
  return {
    ...frame,
    pngBase64: frame.pngBase64 ?? frame.png_base64 ?? null,
    frameId: Number(frame.frameId ?? frame.frame_id ?? 0),
    mimeType: frame.mimeType ?? frame.mime_type ?? "image/jpeg",
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
