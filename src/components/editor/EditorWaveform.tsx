import { useEffect, useRef } from "react";
import type { Segment, TimelineMap } from "./segments";

export function EditorWaveform({
  peaks,
  segments,
  map,
  durationMs,
  viewStartMs,
  viewEndMs,
}: {
  peaks: number[];
  segments: Segment[];
  /** Displayed-time mapping; columns are sampled in source time through it. */
  map: TimelineMap;
  durationMs: number;
  viewStartMs: number;
  viewEndMs: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const draw = () => {
      const rect = canvas.getBoundingClientRect();
      const scale = window.devicePixelRatio || 1;
      const width = Math.max(1, Math.round(rect.width * scale));
      const height = Math.max(1, Math.round(rect.height * scale));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, width, height);
      if (peaks.length === 0 || durationMs <= 0) return;
      const spanMs = Math.max(1, viewEndMs - viewStartMs);
      const mid = height / 2;
      const columns = Math.max(1, Math.floor(width / (2 * scale)));
      const barWidth = width / columns;
      for (let column = 0; column < columns; column += 1) {
        // Column bounds in displayed time, resolved to source time for sampling.
        const sourceFrom = map.toSource(viewStartMs + (column / columns) * spanMs);
        const sourceTo = map.toSource(viewStartMs + ((column + 1) / columns) * spanMs);
        const from = Math.max(0, Math.floor((sourceFrom / durationMs) * peaks.length));
        const to = Math.min(peaks.length, Math.max(from + 1, Math.ceil((sourceTo / durationMs) * peaks.length)));
        let peak = 0;
        for (let index = from; index < to; index += 1) {
          const value = peaks[index] ?? 0;
          if (value > peak) peak = value;
        }
        const x = column * barWidth;
        const atMs = map.toSource(viewStartMs + ((column + 0.5) / columns) * spanMs);
        const kept = map.collapsed || segments.some((segment) => atMs >= segment.startMs && atMs <= segment.endMs);
        ctx.fillStyle = kept ? "rgba(0, 216, 240, 0.9)" : "rgba(0, 216, 240, 0.32)";
        const half = Math.max(scale * 0.5, peak * (mid - scale * 2));
        ctx.fillRect(x, mid - half, Math.max(scale, barWidth - scale), half * 2);
      }
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [peaks, segments, map, durationMs, viewStartMs, viewEndMs]);

  return <canvas ref={ref} className="editor-wave" aria-hidden="true" />;
}
