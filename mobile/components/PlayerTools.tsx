import { formatCount } from "@/lib/format";
import type { ReactNode } from "react";
import Ionicons from "@expo/vector-icons/Ionicons";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors, glowSm } from "@/lib/theme";

export function PlayerTools({
  liked,
  likeCount = 0,
  commentCount = 0,
  onLike,
  onComment,
  onCopy,
  onSend,
  onMore,
  bottom = 88,
  header,
}: {
  liked: boolean;
  likeCount?: number;
  commentCount?: number;
  onLike: () => void;
  onComment: () => void;
  onCopy: () => void;
  onSend?: () => void;
  onMore: () => void;
  bottom?: number;
  header?: ReactNode;
}) {
  return (
    <View style={[styles.rail, { bottom }]} pointerEvents="box-none">
      {header}
      <Tool
        icon={liked ? "heart" : "heart-outline"}
        label={formatCount(likeCount) || "Like"}
        color={liked ? colors.accent : "#fff"}
        glow={liked}
        onPress={onLike}
      />
      <Tool icon="chatbubble-outline" label={formatCount(commentCount) || "Comment"} onPress={onComment} />
      <Tool icon="link-outline" label="Copy" onPress={onCopy} />
      {onSend ? <Tool icon="paper-plane-outline" label="Send" onPress={onSend} /> : null}
      <Tool icon="ellipsis-horizontal" label="More" onPress={onMore} />
    </View>
  );
}

function Tool({
  icon,
  label,
  color = "#fff",
  glow = false,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  color?: string;
  glow?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={styles.tool} hitSlop={10}>
      <View style={[styles.iconWrap, glow && styles.iconWrapOn]}>
        <Ionicons name={icon} size={28} color={color} />
      </View>
      <Text style={styles.label}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  rail: {
    position: "absolute",
    right: 10,
    bottom: 88,
    alignItems: "center",
    gap: 16,
    zIndex: 4,
    elevation: 4,
  },
  tool: { alignItems: "center", gap: 4 },
  iconWrap: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: "rgba(0,0,0,0.42)",
    alignItems: "center",
    justifyContent: "center",
  },
  iconWrapOn: {
    backgroundColor: "rgba(0, 216, 240, 0.18)",
    ...glowSm,
  },
  label: { color: "#fff", fontSize: 12, fontWeight: "700" },
});
