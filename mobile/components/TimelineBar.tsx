import { useRef, useState } from "react";
import {
  StyleSheet,
  Text,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
} from "react-native";
import { formatClockSeconds } from "@/lib/format";
import { colors } from "@/lib/theme";

export function TimelineBar({
  current,
  duration,
  bottom,
  onSeek,
  onSeekStart,
  onSeekEnd,
}: {
  current: number;
  duration: number;
  bottom: number;
  onSeek?: (seconds: number) => void;
  onSeekStart?: () => void;
  onSeekEnd?: (seconds: number) => void;
}) {
  const hitRef = useRef<View>(null);
  const barPageX = useRef(0);
  const barWidth = useRef(1);
  const measured = useRef(false);
  const [dragging, setDragging] = useState(false);
  const [dragProgress, setDragProgress] = useState(0);

  const total = duration > 0 ? duration : 0;
  const liveProgress = total > 0 ? Math.min(1, Math.max(0, current / total)) : 0;
  const progress = dragging ? dragProgress : liveProgress;
  const displaySeconds = dragging ? dragProgress * total : current;

  function measureBar() {
    hitRef.current?.measureInWindow((x, _y, width) => {
      barPageX.current = x;
      if (width > 0) barWidth.current = width;
      measured.current = true;
    });
  }

  function secondsFromEvent(event: GestureResponderEvent) {
    if (total <= 0) return 0;
    const width = Math.max(1, barWidth.current);
    const x = measured.current
      ? event.nativeEvent.pageX - barPageX.current
      : event.nativeEvent.locationX;
    const ratio = Math.min(1, Math.max(0, x / width));
    return ratio * total;
  }

  function applySeek(seconds: number, opts?: { end?: boolean; start?: boolean }) {
    const nextProgress = total > 0 ? seconds / total : 0;
    setDragProgress(nextProgress);
    if (opts?.start) {
      setDragging(true);
      onSeekStart?.();
    }
    onSeek?.(seconds);
    if (opts?.end) {
      setDragging(false);
      onSeekEnd?.(seconds);
    }
  }

  function beginSeek(event: GestureResponderEvent) {
    measureBar();
    applySeek(secondsFromEvent(event), { start: true });
  }

  function moveSeek(event: GestureResponderEvent) {
    applySeek(secondsFromEvent(event));
  }

  function endSeek(event: GestureResponderEvent) {
    applySeek(secondsFromEvent(event), { end: true });
  }

  function onLayout(event: LayoutChangeEvent) {
    const width = event.nativeEvent.layout.width;
    if (width > 0) barWidth.current = width;
    measureBar();
  }

  return (
    <View style={[styles.wrap, { bottom }]} pointerEvents="box-none">
      <View
        ref={hitRef}
        style={styles.hit}
        onLayout={onLayout}
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        onResponderTerminationRequest={() => false}
        onResponderGrant={beginSeek}
        onResponderMove={moveSeek}
        onResponderRelease={endSeek}
        onResponderTerminate={endSeek}
      >
        <View style={styles.track}>
          <View style={[styles.fill, { width: `${progress * 100}%` }]} />
        </View>
        <View style={[styles.knob, { left: `${progress * 100}%` }]} />
      </View>
      <View style={styles.times} pointerEvents="none">
        <Text style={styles.clock}>{formatClockSeconds(displaySeconds)}</Text>
        <Text style={styles.clock}>{formatClockSeconds(total)}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: "absolute",
    left: 30,
    right: 30,
    gap: 6,
  },
  times: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  clock: { color: "rgba(255,255,255,0.78)", fontSize: 11, fontVariant: ["tabular-nums"], fontWeight: "600" },
  hit: { height: 30, justifyContent: "center" },
  track: {
    height: 3,
    backgroundColor: "rgba(255,255,255,0.22)",
    borderRadius: 2,
    overflow: "hidden",
  },
  fill: {
    height: 3,
    backgroundColor: colors.accent,
  },
  knob: {
    position: "absolute",
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: "#fff",
    marginLeft: -7,
    top: 8,
  },
});
