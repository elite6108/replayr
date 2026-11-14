import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { sanitizePageUrl } from "../../recording/browserSource";
import { browserPreviewBounds } from "../../recording/browserPreview";
import { createPreviewFeed, useFeedCanvas } from "../../recording/previewPoll";
import { browserSettingsOf, type RecordingSource } from "../../recording/scene";
import {
  placeBrowserPreview,
  setBrowserPreviewInteractive,
  startBrowserPreview,
  stopBrowserPreview,
  waitBrowserPreviewFrame,
} from "../../services/tauri";

const DRAG_BORDER = 8;

/** Keeps each browser page open over the preview, including while a recording replaces the layers. */
export function BrowserPreviewHost({
  sources,
  selectedId,
  enabled,
  canvasRef,
  inset,
}: {
  sources: RecordingSource[];
  selectedId: string | null;
  enabled: boolean;
  canvasRef: RefObject<HTMLDivElement | null>;
  inset: boolean;
}) {
  if (!enabled) return null;
  const pages = sources.filter((source) => {
    if (source.type !== "browser" || !source.enabled || !source.transform) return false;
    return Boolean(sanitizePageUrl(browserSettingsOf(source).url));
  });
  const ordered = [...pages].sort((a, b) => Number(a.id === selectedId) - Number(b.id === selectedId));
  return (
    <>
      {ordered.map((source) => (
        <BrowserPreviewWindow
          key={source.id}
          source={source}
          interactive
          canvasRef={canvasRef}
          insetCss={inset ? DRAG_BORDER : 0}
        />
      ))}
    </>
  );
}

function BrowserPreviewWindow({
  source,
  interactive,
  canvasRef,
  insetCss,
}: {
  source: RecordingSource;
  interactive: boolean;
  canvasRef: RefObject<HTMLDivElement | null>;
  insetCss: number;
}) {
  const url = sanitizePageUrl(browserSettingsOf(source).url) ?? "";
  const transform = source.transform;
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!url) return;
    let stopped = false;
    let generation = 0;
    setReady(false);
    void startBrowserPreview(source.id, url).then(
      (next) => {
        generation = next;
        if (stopped) {
          void stopBrowserPreview(source.id, next);
          return;
        }
        setReady(true);
      },
      () => undefined,
    );
    return () => {
      stopped = true;
      setReady(false);
      if (generation) void stopBrowserPreview(source.id, generation);
    };
  }, [source.id, url]);

  useEffect(() => {
    void setBrowserPreviewInteractive(source.id, interactive).catch(() => undefined);
  }, [source.id, interactive]);

  useEffect(() => {
    if (!ready || !transform) return;
    let frame = 0;
    let last = "";
    const tick = () => {
      frame = window.requestAnimationFrame(tick);
      const host = canvasRef.current?.getBoundingClientRect();
      if (!host) return;
      // CSS pixels. The window scales them with its own DPI so the page lands on this box.
      const bounds = browserPreviewBounds(host, transform, 1, insetCss);
      if (!bounds) return;
      const key = `${bounds.x},${bounds.y},${bounds.width},${bounds.height},${interactive ? 1 : 0}`;
      if (key === last) return;
      last = key;
      void placeBrowserPreview({ sourceId: source.id, ...bounds, interactive }).catch(() => undefined);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [ready, canvasRef, source.id, transform, interactive, insetCss]);

  return null;
}

type BrowserFrameHeader = { width: number; height: number; frameId: number; mimeType: string };

/** Captured page in the source box, the same frames a recording already draws. */
export function BrowserLivePreview({ sourceId, active }: { sourceId: string; active: boolean }) {
  const feed = useMemo(
    () =>
      createPreviewFeed<BrowserFrameHeader>({
        label: `browser-${sourceId}`,
        wait: (after) => waitBrowserPreviewFrame(sourceId, after),
        headerKey: (header) => `${header.width}\0${header.height}`,
      }),
    [sourceId],
  );
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useFeedCanvas(feed, canvasRef, active);
  if (!active) return null;
  return <canvas ref={canvasRef} className="preview-browser-open" />;
}
