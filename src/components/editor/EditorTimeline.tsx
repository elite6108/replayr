import { useEffect, useRef, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import {
  ArrowsInLineHorizontal,
  Eye,
  MagicWand,
  MagnifyingGlassMinus,
  MagnifyingGlassPlus,
  Scissors,
  Selection,
  SpeakerHigh,
  Trash,
} from "@phosphor-icons/react";
import { formatClock, formatDuration } from "../../utils/format";
import { EditorWaveform } from "./EditorWaveform";
import {
  MAX_ZOOM,
  MIN_ZOOM,
  clampZoom,
  pctInView,
  totalMs,
  type Segment,
  type SegmentEdge,
  type TimelineMap,
} from "./segments";

type RulerMark = { ms: number; major: boolean; edge: "start" | "end" | null; precise: boolean };

const STEP_CANDIDATES_S = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];

function rulerMarks(durationMs: number, viewStartMs: number, viewEndMs: number): RulerMark[] {
  const spanMs = viewEndMs - viewStartMs;
  if (durationMs <= 0 || spanMs <= 0) return [{ ms: 0, major: true, edge: "start", precise: false }];
  const spanS = spanMs / 1000;
  const step = STEP_CANDIDATES_S.find((candidate) => spanS / candidate <= 12) ?? 300;
  const minor = step / 5;
  const precise = step < 1;
  const marks: RulerMark[] = [];
  const first = Math.floor(viewStartMs / 1000 / minor) * minor;
  const guardMs = spanMs * 0.04;
  const end = Math.round(durationMs);
  for (let at = first; at * 1000 <= viewEndMs + 1; at += minor) {
    const ms = Math.round(at * 1000);
    if (ms < 0 || ms > end) continue;
    const major = Math.abs(at / step - Math.round(at / step)) < 0.02;
    // Labels that would collide with the right-aligned clip-end label are dropped.
    if (major && ms !== end && end - ms < guardMs && end <= viewEndMs + 1) continue;
    marks.push({ ms, major, edge: ms === 0 ? "start" : ms === end ? "end" : null, precise });
  }
  if (end <= viewEndMs + 1 && !marks.some((mark) => mark.ms === end)) {
    marks.push({ ms: end, major: true, edge: "end", precise });
  }
  return marks;
}

function sliderFromZoom(zoom: number): number {
  return Math.round((Math.log(clampZoom(zoom) / MIN_ZOOM) / Math.log(MAX_ZOOM / MIN_ZOOM)) * 100);
}

function zoomFromSlider(value: number): number {
  return clampZoom(MIN_ZOOM * Math.pow(MAX_ZOOM / MIN_ZOOM, Math.max(0, Math.min(100, value)) / 100));
}

export function EditorTimeline({
  timelineRef,
  durationMs,
  segments,
  map,
  selectedSegmentId,
  startMs,
  endMs,
  startText,
  endText,
  playheadMs,
  viewStartMs,
  viewEndMs,
  zoom,
  frames,
  peaks,
  onPointerDown,
  onHandlePointerDown,
  onPlayheadPointerDown,
  onSelectSegment,
  onSplit,
  onDeleteSelected,
  onJoinSelected,
  onJoinSeam,
  onStartText,
  onEndText,
  onCommitClock,
  onReset,
  onPreviewSelection,
  onZoom,
  onScroll,
}: {
  timelineRef: RefObject<HTMLDivElement | null>;
  durationMs: number;
  segments: Segment[];
  /** Source-time to displayed-time mapping; collapsed when several sections are kept. */
  map: TimelineMap;
  selectedSegmentId: string | null;
  startMs: number;
  endMs: number;
  startText: string;
  endText: string;
  playheadMs: number;
  viewStartMs: number;
  viewEndMs: number;
  zoom: number;
  frames: string[];
  /** null while loading, empty when the clip has no decodable audio. */
  peaks: number[] | null;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onHandlePointerDown: (segmentId: string, edge: SegmentEdge) => void;
  onPlayheadPointerDown: () => void;
  onSelectSegment: (id: string | null) => void;
  onSplit: () => void;
  onDeleteSelected: () => void;
  onJoinSelected: () => void;
  /** Rejoins the two sections meeting at a seam, restoring the footage between them. */
  onJoinSeam: (beforeId: string) => void;
  onStartText: (value: string) => void;
  onEndText: (value: string) => void;
  onCommitClock: (which: "start" | "end", value: string) => void;
  onReset: () => void;
  onPreviewSelection: () => void;
  /** `anchorFrac` is the horizontal fraction of the view that should stay fixed. */
  onZoom: (nextZoom: number, anchorMs: number, anchorFrac: number) => void;
  onScroll: (nextViewStartMs: number) => void;
}) {
  const gridRef = useRef<HTMLDivElement>(null);
  const scrollDragRef = useRef<{ startClientX: number; startViewMs: number; trackWidth: number } | null>(null);

  const spanMs = Math.max(1, viewEndMs - viewStartMs);
  const domainMs = map.domainMs;
  const marks = rulerMarks(domainMs, viewStartMs, viewEndMs);
  /** Displayed-time ms -> percent of the visible window. */
  const pctT = (timelineMs: number) => pctInView(timelineMs, viewStartMs, viewEndMs);
  /** Source-time ms -> percent of the visible window. */
  const pct = (sourceMs: number) => pctT(map.toTimeline(sourceMs));
  const clampPct = (value: number) => Math.max(0, Math.min(100, value));

  const selectedIndex = segments.findIndex((segment) => segment.id === selectedSegmentId);
  const selected = selectedIndex >= 0 ? segments[selectedIndex] : null;
  const canDelete = selected !== null && segments.length > 1;
  const canJoin = selected !== null && selectedIndex < segments.length - 1;
  const zoomed = zoom > MIN_ZOOM + 0.001;

  // React registers wheel listeners as passive, so a native listener is needed to
  // stop the page from scrolling while zooming or panning the timeline.
  useEffect(() => {
    const node = gridRef.current;
    const track = timelineRef.current;
    if (!node || !track || durationMs <= 0) return;
    function onWheel(event: WheelEvent) {
      if (!track) return;
      event.preventDefault();
      const rect = track.getBoundingClientRect();
      if (event.ctrlKey || event.metaKey) {
        const frac = rect.width > 0 ? Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) : 0.5;
        const anchorMs = viewStartMs + frac * spanMs;
        const factor = Math.exp(-event.deltaY * 0.0015);
        onZoom(clampZoom(zoom * factor), anchorMs, frac);
        return;
      }
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      onScroll(viewStartMs + (delta / Math.max(1, rect.width)) * spanMs);
    }
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, [durationMs, onScroll, onZoom, spanMs, timelineRef, viewStartMs, zoom]);

  useEffect(() => {
    function onMove(event: PointerEvent) {
      const drag = scrollDragRef.current;
      if (!drag) return;
      const dx = event.clientX - drag.startClientX;
      onScroll(drag.startViewMs + (dx / Math.max(1, drag.trackWidth)) * domainMs);
    }
    function onUp() {
      scrollDragRef.current = null;
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [domainMs, onScroll]);

  // Dimmed footage outside the kept range only exists in single-section mode;
  // once collapsed, removed footage is not drawn at all.
  const gaps: Array<{ from: number; to: number }> = [];
  if (!map.collapsed && segments.length > 0) {
    const first = segments[0]!;
    if (first.startMs > 0) gaps.push({ from: 0, to: first.startMs });
    if (first.endMs < durationMs) gaps.push({ from: first.endMs, to: durationMs });
  }

  const stepZoom = (direction: -1 | 1) => {
    const next = zoomFromSlider(sliderFromZoom(zoom) + direction * 12.5);
    onZoom(next, viewStartMs + spanMs / 2, 0.5);
  };

  return (
    <section className="editor-timeline-wrap" aria-label="Timeline">
      <div className="editor-timeline-toolbar">
        <button type="button" className="editor-tl-icon" onClick={onSplit} title="Split at playhead (S)" aria-label="Split at playhead">
          <Scissors size={14} />
        </button>
        <button
          type="button"
          className="editor-tl-icon"
          disabled={!canDelete}
          onClick={onDeleteSelected}
          title={canDelete ? "Delete selected section (Delete)" : "Select a section to delete it"}
          aria-label="Delete selected section"
        >
          <Trash size={14} />
        </button>
        <button
          type="button"
          className="editor-tl-icon"
          disabled={!canJoin}
          onClick={onJoinSelected}
          title={canJoin ? "Join with the next section" : "Select a section that has a neighbour to join"}
          aria-label="Join with next section"
        >
          <ArrowsInLineHorizontal size={14} />
        </button>
        <button type="button" className="editor-tl-icon" onClick={onPreviewSelection} title="Preview kept sections" aria-label="Preview kept sections">
          <MagicWand size={14} />
        </button>
        <span className="editor-tl-chip" title="Coming soon">
          <Selection size={12} />
          Auto Reframe
          <span className="editor-beta">Beta</span>
        </span>
        {segments.length > 1 ? (
          <span className="editor-tl-sections">
            {segments.length} sections · {formatDuration(totalMs(segments))} kept
          </span>
        ) : null}
        <div className="editor-tl-zoom">
          <button type="button" className="editor-tl-zoom-btn" onClick={() => stepZoom(-1)} disabled={zoom <= MIN_ZOOM} aria-label="Zoom out">
            <MagnifyingGlassMinus size={14} />
          </button>
          <input
            type="range"
            min={0}
            max={100}
            value={sliderFromZoom(zoom)}
            aria-label="Timeline zoom"
            title={`Zoom ${zoom.toFixed(1)}×`}
            onChange={(event) => onZoom(zoomFromSlider(Number(event.target.value)), viewStartMs + spanMs / 2, 0.5)}
          />
          <button type="button" className="editor-tl-zoom-btn" onClick={() => stepZoom(1)} disabled={zoom >= MAX_ZOOM} aria-label="Zoom in">
            <MagnifyingGlassPlus size={14} />
          </button>
        </div>
      </div>
      <div className="editor-timeline-grid" ref={gridRef}>
        <div className="editor-gutter" aria-hidden="true">
          <span className="editor-gutter-ruler" />
          <span className="editor-gutter-label">
            <Eye size={12} />
            Video
          </span>
          <span className="editor-gutter-label">
            <SpeakerHigh size={12} />
            Audio
          </span>
        </div>
        <div ref={timelineRef} className="editor-timeline" onPointerDown={onPointerDown}>
          <div className="editor-ruler">
            {marks.map((mark, index) => (
              <span
                key={`${mark.ms}-${index}`}
                className={`${mark.major ? "major" : "minor"}${mark.edge ? ` edge-${mark.edge}` : ""}`}
                style={{ left: `${pctT(mark.ms)}%` }}
              >
                {mark.major ? <b>{formatClock(mark.ms, mark.precise)}</b> : null}
              </span>
            ))}
          </div>
          <div className="editor-track-block">
            <div className="editor-track editor-track-video">
              {map.pieces.map((piece) => {
                const lengthMs = Math.max(1, piece.endMs - piece.startMs);
                const left = pctT(piece.offsetMs);
                const width = (lengthMs / spanMs) * 100;
                if (left > 100 || left + width < 0) return null;
                // Each piece is a window onto the full filmstrip, shifted so its
                // own source range lines up; frames are shared, never refetched.
                return (
                  <div
                    key={piece.id}
                    className="editor-strip-piece"
                    style={{ left: `${left}%`, width: `${width}%` }}
                  >
                    <div
                      className="editor-strip"
                      style={{
                        width: `${durationMs > 0 ? (durationMs / lengthMs) * 100 : 100}%`,
                        transform: `translateX(${durationMs > 0 ? -(piece.startMs / durationMs) * 100 : 0}%)`,
                      }}
                    >
                      {frames.length > 0
                        ? frames.map((frame) => <img key={frame} src={frame} alt="" draggable={false} />)
                        : Array.from({ length: 12 }, (_, index) => <span key={index} className="editor-strip-empty" />)}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="editor-track editor-track-audio">
              {peaks === null ? (
                <span className="editor-track-note">Loading audio…</span>
              ) : peaks.length > 0 ? (
                <EditorWaveform
                  peaks={peaks}
                  segments={segments}
                  map={map}
                  durationMs={durationMs}
                  viewStartMs={viewStartMs}
                  viewEndMs={viewEndMs}
                />
              ) : (
                <span className="editor-track-note">No audio track</span>
              )}
            </div>
          </div>
          {gaps.map((gap) => {
            const left = clampPct(pct(gap.from));
            const right = clampPct(pct(gap.to));
            if (right <= left) return null;
            return (
              <div
                key={`${gap.from}-${gap.to}`}
                className="editor-dim"
                style={{ left: `${left}%`, width: `${right - left}%` }}
              />
            );
          })}
          {segments.map((segment) => {
            const left = pct(segment.startMs);
            const right = pct(segment.endMs);
            if (right < 0 || left > 100) return null;
            return (
              <div
                key={segment.id}
                className={`editor-range${segment.id === selectedSegmentId ? " on" : ""}`}
                style={{ left: `${left}%`, width: `${Math.max(0, right - left)}%` }}
                data-segment={segment.id}
                onPointerDown={() => onSelectSegment(segment.id)}
              />
            );
          })}
          {map.seams.map((seam) => {
            const at = pctT(seam.atMs);
            if (at < -1 || at > 101) return null;
            return (
              <div
                key={`seam-${seam.beforeId}`}
                className="editor-seam"
                style={{ left: `${at}%` }}
                data-handle="seam"
                onPointerDown={(event) => {
                  event.stopPropagation();
                  onSelectSegment(seam.beforeId);
                }}
              >
                <button
                  type="button"
                  className="editor-seam-join"
                  title="Rejoin — restore removed footage"
                  aria-label="Rejoin sections"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    onJoinSeam(seam.beforeId);
                  }}
                >
                  <ArrowsInLineHorizontal size={11} />
                </button>
              </div>
            );
          })}
          {segments.map((segment, index) =>
            (["start", "end"] as const).map((edge) => {
              const at = pct(edge === "start" ? segment.startMs : segment.endMs);
              if (at < -1 || at > 101) return null;
              // In collapsed mode a section's start handle sits on the same seam as
              // the previous section's end handle; offset them so both stay grabbable.
              const onSeam = map.collapsed && (edge === "start" ? index > 0 : index < segments.length - 1);
              return (
                <button
                  key={`${segment.id}-${edge}`}
                  type="button"
                  className={`editor-handle editor-handle-${edge}${onSeam ? " is-seam" : ""}`}
                  style={{ left: `${at}%` }}
                  data-handle={`${segment.id}:${edge}`}
                  aria-label={edge === "start" ? "Section start" : "Section end"}
                  onPointerDown={(event) => {
                    event.stopPropagation();
                    onSelectSegment(segment.id);
                    onHandlePointerDown(segment.id, edge);
                  }}
                />
              );
            }),
          )}
          <button
            type="button"
            className="editor-playhead"
            style={{ left: `${pct(playheadMs)}%` }}
            data-handle="playhead"
            aria-label="Playhead"
            onPointerDown={(event) => {
              event.stopPropagation();
              onPlayheadPointerDown();
            }}
          />
        </div>
        <span className="editor-gutter-spacer" aria-hidden="true" />
        <div
          className={`editor-scrollbar${zoomed ? " is-active" : ""}`}
          role="scrollbar"
          aria-controls="editor-timeline"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={domainMs > 0 ? Math.round((viewStartMs / domainMs) * 100) : 0}
          onPointerDown={(event) => {
            if (!zoomed) return;
            const rect = event.currentTarget.getBoundingClientRect();
            const frac = (event.clientX - rect.left) / Math.max(1, rect.width);
            onScroll(frac * domainMs - spanMs / 2);
          }}
        >
          <div
            className="editor-scrollbar-thumb"
            style={{ left: `${domainMs > 0 ? (viewStartMs / domainMs) * 100 : 0}%`, width: `${100 / zoom}%` }}
            onPointerDown={(event) => {
              if (!zoomed) return;
              event.stopPropagation();
              const track = event.currentTarget.parentElement;
              scrollDragRef.current = {
                startClientX: event.clientX,
                startViewMs: viewStartMs,
                trackWidth: track ? track.getBoundingClientRect().width : 1,
              };
            }}
          />
        </div>
      </div>
      <div className="editor-timeline-foot">
        <label>
          In
          <input
            value={startText}
            aria-label="Trim start"
            onChange={(event) => onStartText(event.target.value)}
            onBlur={(event) => onCommitClock("start", event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
        </label>
        <label>
          Out
          <input
            value={endText}
            aria-label="Trim end"
            onChange={(event) => onEndText(event.target.value)}
            onBlur={(event) => onCommitClock("end", event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
        </label>
        <span className="editor-selected">
          Selected
          <strong>
            {formatClock(startMs, true)} → {formatClock(endMs, true)}
          </strong>
          <em>{formatDuration(segments.length > 1 ? totalMs(segments) : Math.max(0, endMs - startMs))}</em>
        </span>
        <button type="button" className="editor-text-btn" onClick={onReset} title="Reset trim and sections">
          Reset
        </button>
        <span className="editor-shortcut-line" title="Shift + arrow nudges 5 seconds. Ctrl + scroll zooms, scroll pans.">
          Space: play · I / O: mark range · S: split · Del: remove section · Ctrl + scroll: zoom
        </span>
      </div>
    </section>
  );
}
