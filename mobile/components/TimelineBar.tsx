import { useState } from "react";
import { StyleSheet, Text, View, type GestureResponderEvent } from "react-native";
import { formatClockSeconds } from "@/lib/format";

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
      <View style={styles.times}>
        <Text style={styles.clock}>{formatClockSeconds(current)}</Text>
        <Text style={styles.clock}>{formatClockSeconds(total)}</Text>
      </View>
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
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: "absolute",
    left: 16,
    right: 16,
    gap: 4,
  },
  times: { flexDirection: "row", justifyContent: "space-between" },
  clock: { color: "#ffffffcc", fontSize: 11, fontVariant: ["tabular-nums"] },
  hit: { height: 16, justifyContent: "center" },
  track: {
    height: 2,
    backgroundColor: "#ffffff33",
    borderRadius: 1,
    overflow: "hidden",
  },
  fill: {
    height: 2,
    backgroundColor: "#fff",
  },
  knob: {
    position: "absolute",
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "#fff",
    marginLeft: -4,
  },
});
