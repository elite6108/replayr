/** Live preview feeds: one long-poll per source kind, decode off the main thread, draw on rAF. */

import { useEffect, type RefObject } from "react";
import { waitCameraPreviewFrame, waitCapturePreviewFrame } from "../services/tauri";
import type { CapturePreviewHeader } from "../types/capturePreview";
import type { CameraPreviewHeader } from "../types/camera";

export type PreviewDiag = {
  offered: number;
  rendered: number;
  duplicatesSkipped: number;
  dropped: number;
  lastLogAt: number;
  ipcMsSum: number;
  ipcMsMax: number;
  presentMsSum: number;
  presentMsMax: number;
  timed: number;
};

export function createPreviewDiag(): PreviewDiag {
  return {
    offered: 0,
    rendered: 0,
    duplicatesSkipped: 0,
    dropped: 0,
    lastLogAt: 0,
    ipcMsSum: 0,
    ipcMsMax: 0,
    presentMsSum: 0,
    presentMsMax: 0,
    timed: 0,
  };
}

export function notePreviewTiming(diag: PreviewDiag, ipcMs: number, presentMs: number) {
  diag.timed += 1;
  diag.ipcMsSum += ipcMs;
  diag.presentMsSum += presentMs;
  if (ipcMs > diag.ipcMsMax) diag.ipcMsMax = ipcMs;
  if (presentMs > diag.presentMsMax) diag.presentMsMax = presentMs;
}

export function logPreviewDiag(label: string, diag: PreviewDiag, extra?: Record<string, unknown>) {
  const now = performance.now();
  if (now - diag.lastLogAt < 5000) return;
  diag.lastLogAt = now;
  const n = Math.max(1, diag.timed);
  console.info(`[preview:${label}]`, {
    offered: diag.offered,
    rendered: diag.rendered,
    duplicatesSkipped: diag.duplicatesSkipped,
    dropped: diag.dropped,
    ipcAvgMs: Number((diag.ipcMsSum / n).toFixed(2)),
    ipcMaxMs: Number(diag.ipcMsMax.toFixed(2)),
    presentAvgMs: Number((diag.presentMsSum / n).toFixed(2)),
    presentMaxMs: Number(diag.presentMsMax.toFixed(2)),
    ...extra,
  });
}

type FeedHeader = { frameId: number; width: number; height: number; mimeType: string };

export type PreviewFeedState<H extends FeedHeader> = {
  header: H | null;
  /** Newest decoded frame. Closed by the feed once a newer one replaces it. */
  bitmap: ImageBitmap | null;
  /** Bumps on every new bitmap, so a canvas draws each frame once. */
  seq: number;
};

export type PreviewFeed<H extends FeedHeader> = {
  /** Current shared state. Read it inside requestAnimationFrame. */
  state: () => PreviewFeedState<H>;
  /** The listener fires when the header (minus frameId) or bitmap presence changes, not per frame. */
  subscribe: (listener: () => void) => () => void;
  /** Drop the current frame so the next wait returns the newest one, e.g. after a source switch. */
  reset: () => void;
  /** A canvas calls this after drawing the current bitmap, for the diagnostics. */
  noteDrawn: () => void;
};

type WaitResult<H> = { header: H; bytes: Uint8Array<ArrayBuffer> | null };

const delay = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/** One long-poll loop shared by every mounted layer of the same kind. */
export function createPreviewFeed<H extends FeedHeader>(options: {
  label: string;
  wait: (after: number) => Promise<WaitResult<H>>;
  headerKey: (header: H) => string;
}): PreviewFeed<H> {
  const feed: PreviewFeedState<H> = { header: null, bitmap: null, seq: 0 };
  const listeners = new Set<() => void>();
  const diag = createPreviewDiag();
  let headerKey = "";
  let running = false;
  let generation = 0;
  let undrawn = false;
  let drawn = 0;

  const setBitmap = (bitmap: ImageBitmap | null) => {
    if (feed.bitmap && feed.bitmap !== bitmap) feed.bitmap.close();
    feed.bitmap = bitmap;
    feed.seq += 1;
  };

  const emit = () => {
    const key = feed.header ? `${options.headerKey(feed.header)}\0${feed.bitmap ? 1 : 0}` : "";
    if (key === headerKey) return;
    headerKey = key;
    for (const listener of listeners) listener();
  };

  const reset = () => {
    setBitmap(null);
    undrawn = false;
    feed.header = null;
    emit();
  };

  const run = async (mine: number) => {
    const active = () => running && mine === generation;
    while (active()) {
      const after = feed.bitmap ? (feed.header?.frameId ?? 0) : 0;
      const waitStarted = performance.now();
      let result: WaitResult<H>;
      try {
        result = await options.wait(after);
      } catch {
        if (!active()) return;
        await delay(250);
        continue;
      }
      const ipcMs = performance.now() - waitStarted;
      if (!active()) return;
      const { header, bytes } = result;
      diag.offered += 1;

      if (!bytes) {
        if (header.frameId === 0 && feed.bitmap) setBitmap(null);
        feed.header = header;
        emit();
        diag.duplicatesSkipped += 1;
        notePreviewTiming(diag, ipcMs, 0);
        // A header-only reply that came back early means nothing is producing frames; don't spin.
        if (ipcMs < 50) await delay(50 - ipcMs);
        continue;
      }

      const decodeStarted = performance.now();
      let bitmap: ImageBitmap;
      try {
        const mime = header.mimeType?.startsWith("image/") ? header.mimeType : "image/jpeg";
        bitmap = await createImageBitmap(new Blob([bytes], { type: mime }));
      } catch {
        diag.dropped += 1;
        continue;
      }
      const decodeMs = performance.now() - decodeStarted;
      if (!active()) {
        bitmap.close();
        return;
      }
      if (undrawn) diag.dropped += 1;
      setBitmap(bitmap);
      undrawn = true;
      feed.header = header;
      emit();
      diag.rendered += 1;
      notePreviewTiming(diag, ipcMs, decodeMs);
      logPreviewDiag(options.label, diag, {
        width: header.width,
        height: header.height,
        frameId: header.frameId,
        drawn,
      });
    }
  };

  return {
    state: () => feed,
    subscribe: (listener) => {
      listeners.add(listener);
      if (!running) {
        running = true;
        void run(++generation);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          running = false;
          generation += 1;
          reset();
        }
      };
    },
    reset,
    noteDrawn: () => {
      if (undrawn) drawn += 1;
      undrawn = false;
    },
  };
}

export const capturePreviewFeed = createPreviewFeed<CapturePreviewHeader>({
  label: "capture",
  wait: (after) => waitCapturePreviewFrame(after),
  headerKey: (header) => `${header.state}\0${header.label}\0${header.source}\0${header.width}\0${header.height}`,
});

export const cameraPreviewFeed = createPreviewFeed<CameraPreviewHeader>({
  label: "webcam",
  wait: (after) => waitCameraPreviewFrame(after),
  headerKey: (header) => `${header.width}\0${header.height}\0${header.mirrored}`,
});

/** Draws each new feed bitmap onto the canvas once, on requestAnimationFrame, while `active`. */
export function useFeedCanvas<H extends FeedHeader>(
  feed: PreviewFeed<H>,
  canvasRef: RefObject<HTMLCanvasElement | null>,
  active: boolean,
) {
  useEffect(() => {
    if (!active) return;
    let drawnSeq = -1;
    let raf = 0;
    const draw = () => {
      raf = window.requestAnimationFrame(draw);
      const { bitmap, seq } = feed.state();
      const canvas = canvasRef.current;
      if (!canvas || !bitmap || seq === drawnSeq) return;
      if (canvas.width !== bitmap.width) canvas.width = bitmap.width;
      if (canvas.height !== bitmap.height) canvas.height = bitmap.height;
      canvas.getContext("2d", { alpha: false })?.drawImage(bitmap, 0, 0);
      drawnSeq = seq;
      feed.noteDrawn();
    };
    raf = window.requestAnimationFrame(draw);
    return () => window.cancelAnimationFrame(raf);
  }, [feed, canvasRef, active]);
}
