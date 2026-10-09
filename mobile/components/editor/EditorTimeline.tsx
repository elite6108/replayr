import { useEffect, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import { StyleSheet, Text, View, type GestureResponderEvent } from "react-native";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import type { VideoThumbnail } from "expo-video";
import {
  clampViewStart,
  clampZoom,
  pctInView,
  viewSpanMs,
  zoomAround,
} from "../../../src/components/editor/segments.ts";
import { colors } from "@/lib/theme";

const GUTTER = 54;
const LANE = 46;

export function formatEditorClock(ms: number): string {
  const clamped = Math.max(0, Math.round(ms));
  const minutes = Math.floor(clamped / 60_000);
  const seconds = Math.floor(clamped / 1000) % 60;
  const millis = clamped % 1000;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

function rulerStep(spanMs: number): number {
  const steps = [250, 500, 1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000];
  return steps.find((step) => spanMs / step <= 5) ?? 300_000;
}

function rulerLabel(ms: number, step: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (step < 1000) return `${minutes}:${String(seconds).padStart(2, "0")}.${Math.floor((ms % 1000) / 100)}`;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function audioShape(count: number): number[] {
  return Array.from({ length: count }, (_, index) => {
    const a = Math.abs(Math.sin(index * 0.47));
    const b = Math.abs(Math.sin(index * 0.13 + 1.2));
    return 0.18 + a * b * 0.78;
  });
}

type GestureMode = "none" | "pan" | "pinch";

export function EditorTimeline({
  durationMs,
  currentMs,
  rangeStartMs,
  rangeEndMs,
  frames,
  thumbnailUrl,
  trimEnabled,
  playing,
  onSeek,
  onTrim,
}: {
  durationMs: number;
  currentMs: number;
  rangeStartMs: number;
  rangeEndMs: number;
  frames: VideoThumbnail[];
  thumbnailUrl?: string | null;
  trimEnabled: boolean;
  playing: boolean;
  onSeek: (ms: number) => void;
  onTrim: (edge: "start" | "end", ms: number) => void;
}) {
  const duration = Math.max(1, durationMs);
  const [zoom, setZoom] = useState(1);
  const [viewStart, setViewStart] = useState(0);
  const [laneWidth, setLaneWidth] = useState(1);
  const laneLeft = useRef(0);
  const laneRef = useRef<View>(null);
  const zoomRef = useRef(1);
  const viewRef = useRef(0);
  const lastTap = useRef(0);
  const gesture = useRef({
    mode: "none" as GestureMode,
    x: 0,
    view: 0,
    zoom: 1,
    dist: 1,
    anchorMs: 0,
    frac: 0.5,
    moved: false,
  });
  zoomRef.current = zoom;
  viewRef.current = viewStart;
  const span = viewSpanMs(duration, zoom);
  const viewEnd = viewStart + span;
  const bars = useMemo(() => audioShape(140), []);

  useEffect(() => {
    if (!playing || gesture.current.mode !== "none" || zoom <= 1.01) return;
    const pad = span * 0.18;
    if (currentMs < viewStart + pad || currentMs > viewEnd - pad) {
      setViewStart(clampViewStart(currentMs - span * 0.35, duration, zoom));
    }
  }, [currentMs, playing, zoom, span, viewStart, viewEnd, duration]);

  const marks = useMemo(() => {
    const step = rulerStep(span);
    const first = Math.ceil(viewStart / step) * step;
    const next = [];
    for (let ms = first; ms <= viewEnd + 1; ms += step) next.push({ ms, label: rulerLabel(ms, step) });
    return next;
  }, [span, viewStart, viewEnd]);

  const measure = () => {
    laneRef.current?.measureInWindow((x, _y, width) => {
      laneLeft.current = x;
      if (width > 0) setLaneWidth(width);
    });
  };

  const msFromPage = (pageX: number) => {
    const frac = (pageX - laneLeft.current) / Math.max(1, laneWidth);
    const widthMs = viewSpanMs(duration, zoomRef.current);
    return Math.max(0, Math.min(duration, viewRef.current + frac * widthMs));
  };

  const touchDist = (event: GestureResponderEvent) => {
    const points = event.nativeEvent.touches;
    if (!points || points.length < 2) return 0;
    return Math.hypot(points[0].pageX - points[1].pageX, points[0].pageY - points[1].pageY) || 1;
  };

  const onGrant = (event: GestureResponderEvent) => {
    const points = event.nativeEvent.touches;
    if (points && points.length >= 2) {
      const mid = (points[0].pageX + points[1].pageX) / 2;
      const frac = (mid - laneLeft.current) / Math.max(1, laneWidth);
      gesture.current = {
        mode: "pinch",
        x: mid,
        view: viewRef.current,
        zoom: zoomRef.current,
        dist: touchDist(event),
        anchorMs: viewRef.current + frac * viewSpanMs(duration, zoomRef.current),
        frac,
        moved: true,
      };
      return;
    }
    gesture.current = {
      mode: "pan",
      x: event.nativeEvent.pageX,
      view: viewRef.current,
      zoom: zoomRef.current,
      dist: 1,
      anchorMs: 0,
      frac: 0.5,
      moved: false,
    };
  };

  const onMove = (event: GestureResponderEvent) => {
    const points = event.nativeEvent.touches;
    if (points && points.length >= 2) {
      if (gesture.current.mode !== "pinch") onGrant(event);
      const nextZoom = clampZoom(gesture.current.zoom * (touchDist(event) / gesture.current.dist));
      setZoom(nextZoom);
      setViewStart(zoomAround(gesture.current.anchorMs, gesture.current.frac, duration, nextZoom));
      return;
    }
    if (gesture.current.mode !== "pan") return;
    const dx = event.nativeEvent.pageX - gesture.current.x;
    if (Math.abs(dx) > 6) gesture.current.moved = true;
    if (!gesture.current.moved) return;
    const currentZoom = zoomRef.current;
    if (currentZoom > 1.01) {
      const widthMs = viewSpanMs(duration, currentZoom);
      setViewStart(clampViewStart(gesture.current.view - (dx / laneWidth) * widthMs, duration, currentZoom));
      return;
    }
    onSeek(msFromPage(event.nativeEvent.pageX));
  };

  const onRelease = (event: GestureResponderEvent) => {
    if (gesture.current.mode === "pan" && !gesture.current.moved) {
      const now = Date.now();
      const pageX = event.nativeEvent.pageX;
      if (now - lastTap.current < 280) {
        const frac = (pageX - laneLeft.current) / Math.max(1, laneWidth);
        const anchor = viewRef.current + frac * viewSpanMs(duration, zoomRef.current);
        const nextZoom = zoomRef.current >= 8 ? 1 : clampZoom(zoomRef.current * 2);
        setZoom(nextZoom);
        setViewStart(zoomAround(anchor, Math.max(0, Math.min(1, frac)), duration, nextZoom));
        lastTap.current = 0;
      } else {
        lastTap.current = now;
        onSeek(msFromPage(pageX));
      }
    }
    gesture.current.mode = "none";
  };

  const startPct = pctInView(rangeStartMs, viewStart, viewEnd);
  const endPct = pctInView(rangeEndMs, viewStart, viewEnd);
  const playPct = pctInView(currentMs, viewStart, viewEnd);
  const playLeft = GUTTER + (playPct / 100) * laneWidth;
  const stripWidth = laneWidth * zoom;
  const shift = -(viewStart / duration) * stripWidth;

  return (
    <View
      style={styles.wrap}
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
      onResponderGrant={onGrant}
      onResponderMove={onMove}
      onResponderRelease={onRelease}
      onResponderTerminationRequest={() => false}
    >
      <View style={styles.rulerRow}>
        <View style={styles.gutter} />
        <View style={styles.ruler}>
          {marks.map((mark) => (
            <Text key={mark.ms} style={[styles.mark, { left: `${pctInView(mark.ms, viewStart, viewEnd)}%` }]}>
              {mark.label}
            </Text>
          ))}
        </View>
      </View>
      <Track icon="videocam-outline" label="Video" laneRef={laneRef} onLayout={measure}>
        <View style={[styles.strip, { width: stripWidth, transform: [{ translateX: shift }] }]}>
          {frames.length > 0
            ? frames.map((frame, index) => (
                <Image key={`${index}-${frame.requestedTime}`} source={frame} style={styles.tile} contentFit="cover" />
              ))
            : thumbnailUrl
              ? <Image source={{ uri: thumbnailUrl }} style={styles.tile} contentFit="cover" />
              : null}
        </View>
        {trimEnabled ? <Dim left={0} width={Math.max(0, Math.min(100, startPct))} /> : null}
        {trimEnabled ? (
          <Dim left={Math.max(0, Math.min(100, endPct))} width={Math.max(0, 100 - Math.max(0, Math.min(100, endPct)))} />
        ) : null}
        {trimEnabled ? (
          <TrimHandle
            left={(startPct / 100) * laneWidth}
            laneWidth={laneWidth}
            onMove={(pageX) => onTrim("start", msFromPage(pageX))}
          />
        ) : null}
        {trimEnabled ? (
          <TrimHandle
            left={(endPct / 100) * laneWidth}
            laneWidth={laneWidth}
            onMove={(pageX) => onTrim("end", msFromPage(pageX))}
          />
        ) : null}
      </Track>
      <Track icon="volume-medium-outline" label="Audio">
        <View style={[styles.strip, styles.waveRow, { width: stripWidth, transform: [{ translateX: shift }] }]}>
          {bars.map((bar, index) => (
            <View key={index} style={[styles.bar, { height: `${bar * 100}%` }]} />
          ))}
        </View>
      </Track>
      <Track icon="text" label="Text">
        <View style={styles.textLane} />
      </Track>
      <View pointerEvents="none" style={[styles.playhead, { left: playLeft }]}>
        <View style={styles.playheadDot} />
        <View style={styles.playheadLine} />
      </View>
    </View>
  );
}

function Track({
  icon,
  label,
  children,
  laneRef,
  onLayout,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  children: ReactNode;
  laneRef?: Ref<View>;
  onLayout?: () => void;
}) {
  return (
    <View style={styles.row}>
      <View style={styles.gutter}>
        <Ionicons name={icon} size={14} color={colors.muted} />
        <Text style={styles.laneLabel}>{label}</Text>
      </View>
      <View ref={laneRef} style={styles.lane} onLayout={onLayout}>
        {children}
      </View>
    </View>
  );
}

function Dim({ left, width }: { left: number; width: number }) {
  if (width <= 0) return null;
  return <View pointerEvents="none" style={[styles.dim, { left: `${left}%`, width: `${width}%` }]} />;
}

function TrimHandle({ left, laneWidth, onMove }: { left: number; laneWidth: number; onMove: (pageX: number) => void }) {
  if (left < -16 || left > laneWidth + 16) return null;
  return (
    <View
      style={[styles.handle, { left: left - 7 }]}
      onStartShouldSetResponderCapture={() => true}
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
      onResponderTerminationRequest={() => false}
      onResponderMove={(event) => onMove(event.nativeEvent.pageX)}
      onResponderRelease={(event) => onMove(event.nativeEvent.pageX)}
    />
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: 4, position: "relative" },
  rulerRow: { flexDirection: "row", height: 22 },
  gutter: { width: GUTTER, alignItems: "center", justifyContent: "center" },
  ruler: { flex: 1, position: "relative", marginRight: 12 },
  mark: {
    position: "absolute",
    top: 2,
    color: colors.muted,
    fontSize: 10,
    fontVariant: ["tabular-nums"],
    width: 44,
    marginLeft: -22,
    textAlign: "center",
  },
  row: { flexDirection: "row", alignItems: "center", marginBottom: 6 },
  laneLabel: { color: colors.muted, fontSize: 9, marginTop: 2 },
  lane: {
    flex: 1,
    height: LANE,
    borderRadius: 6,
    backgroundColor: "#121820",
    overflow: "hidden",
    marginRight: 12,
  },
  strip: { height: "100%", flexDirection: "row" },
  tile: { flex: 1, height: "100%" },
  waveRow: { alignItems: "center", paddingHorizontal: 1 },
  bar: { flex: 1, marginHorizontal: 0.5, borderRadius: 1, backgroundColor: colors.accent, alignSelf: "center" },
  textLane: { flex: 1 },
  dim: { position: "absolute", top: 0, bottom: 0, backgroundColor: "rgba(0,0,0,0.55)" },
  handle: {
    position: "absolute",
    top: 0,
    width: 14,
    height: LANE,
    borderRadius: 3,
    backgroundColor: colors.accent,
  },
  playhead: { position: "absolute", top: 0, bottom: 6, width: 12, marginLeft: -6, alignItems: "center" },
  playheadDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.accent },
  playheadLine: { width: 2, flex: 1, backgroundColor: colors.accent },
});
