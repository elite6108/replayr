/** Shared preview-poll helpers: one in flight, skip duplicate frameIds, decode before swap. */

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

/** Decode preview bytes before swapping the displayed <img> src. */
export async function decodePreviewDataUrl(base64: string, mimeType = "image/jpeg"): Promise<string> {
  const mime = mimeType.startsWith("image/") ? mimeType : "image/jpeg";
  const url = `data:${mime};base64,${base64}`;
  const probe = new Image();
  probe.decoding = "async";
  probe.src = url;
  try {
    if (typeof probe.decode === "function") {
      await probe.decode();
    }
  } catch {
    // Keep previous frame visible; caller may still assign if needed.
  }
  return url;
}

/** @deprecated Prefer decodePreviewDataUrl — PNG was preview-only and is no longer the default. */
export async function decodePngDataUrl(pngBase64: string): Promise<string> {
  return decodePreviewDataUrl(pngBase64, "image/png");
}

/** Self-scheduling poll: await request → process → wait remainder of interval. */
export function startPreviewPollLoop(options: {
  intervalMs: number;
  cancelled: () => boolean;
  pull: () => Promise<void>;
}): () => void {
  let timer: number | undefined;
  let stopped = false;

  const schedule = (delayMs: number) => {
    timer = window.setTimeout(() => {
      void tick();
    }, delayMs);
  };

  const tick = async () => {
    if (stopped || options.cancelled()) return;
    const started = performance.now();
    try {
      await options.pull();
    } catch {
      // Preview is disposable.
    }
    if (stopped || options.cancelled()) return;
    const elapsed = performance.now() - started;
    schedule(Math.max(0, options.intervalMs - elapsed));
  };

  schedule(0);

  return () => {
    stopped = true;
    if (timer !== undefined) window.clearTimeout(timer);
  };
}
