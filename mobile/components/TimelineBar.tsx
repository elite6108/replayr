import { useState } from "react";
import { StyleSheet, Text, View, type GestureResponderEvent } from "react-native";
import { formatClockSeconds } from "@/lib/format";
import { colors } from "@/lib/theme";

export function TimelineBar({
  current,
  duration,
  bottom,
  onSeek,
}: {
  current: number;
  duration: number;
  bottom: number;
  onSeek?: (seconds: number) => void;
}) {
  const [width, setWidth] = useState(1);
  const total = duration > 0 ? duration : 0;
  const progress = total > 0 ? Math.min(1, Math.max(0, current / total)) : 0;

  function seek(event: GestureResponderEvent) {
    if (!onSeek || total <= 0) return;
    const ratio = Math.min(1, Math.max(0, event.nativeEvent.locationX / width));
    onSeek(ratio * total);
  }

  return (
    <View style={[styles.wrap, { bottom }]}>
      <View
        style={styles.hit}
        onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        onResponderGrant={seek}
        onResponderMove={seek}
      >
        <View style={styles.track}>
          <View style={[styles.fill, { width: `${progress * 100}%` }]} />
        </View>
        <View style={[styles.knob, { left: `${progress * 100}%` }]} />
      </View>
      <View style={styles.times}>
        <Text style={styles.clock}>{formatClockSeconds(current)}</Text>
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
  hit: { height: 18, justifyContent: "center" },
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
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: "#fff",
    marginLeft: -6,
    top: 3,
  },
});
