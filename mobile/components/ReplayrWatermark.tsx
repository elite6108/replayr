import { useState, type ReactNode } from "react";
import { Image, View, StyleSheet } from "react-native";

const LOGO = require("../assets/images/replayr-watermark.png");
const LOGO_ASPECT = 941 / 166;

export function ReplayrWatermark({ show }: { show: boolean }) {
  const [box, setBox] = useState({ w: 0, h: 0 });
  if (!show) return null;
  const short = Math.min(box.w, box.h) || 1;
  const width = Math.max(88, Math.min(168, Math.min(box.w * 0.16 || 88, 168)));
  const height = width / LOGO_ASPECT;
  const margin = Math.max(8, short / 40);
  return (
    <View
      pointerEvents="none"
      style={StyleSheet.absoluteFill}
      onLayout={(event) => {
        const { width: nextW, height: nextH } = event.nativeEvent.layout;
        setBox({ w: nextW, h: nextH });
      }}
    >
      <Image source={LOGO} resizeMode="contain" style={[styles.mark, { right: margin, bottom: margin, width, height }]} />
    </View>
  );
}

export function PlayerVideoFrame({
  width,
  height,
  children,
}: {
  width?: number | null;
  height?: number | null;
  children: ReactNode;
}) {
  const [slot, setSlot] = useState({ w: 0, h: 0 });
  const videoW = width && width > 0 ? width : 16;
  const videoH = height && height > 0 ? height : 9;
  let boxW = slot.w;
  let boxH = slot.h;
  if (slot.w > 0 && slot.h > 0) {
    const slotAspect = slot.w / slot.h;
    const videoAspect = videoW / videoH;
    if (videoAspect > slotAspect) {
      boxW = slot.w;
      boxH = slot.w / videoAspect;
    } else {
      boxH = slot.h;
      boxW = slot.h * videoAspect;
    }
  }
  return (
    <View
      style={styles.slot}
      onLayout={(event) => {
        const { width: nextW, height: nextH } = event.nativeEvent.layout;
        setSlot({ w: nextW, h: nextH });
      }}
    >
      <View style={[styles.frame, { width: boxW, height: boxH }]}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  slot: { flex: 1, alignItems: "center", justifyContent: "center" },
  frame: { position: "relative", backgroundColor: "#000", overflow: "hidden" },
  mark: {
    position: "absolute",
    zIndex: 3,
  },
});
