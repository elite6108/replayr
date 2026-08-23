import Ionicons from "@expo/vector-icons/Ionicons";
import { Pressable, StyleSheet, Text, View } from "react-native";

export function PlayerTools({
  liked,
  likeCount = 0,
  commentCount = 0,
  onLike,
  onComment,
  onCopy,
  onMore,
  bottom = 88,
}: {
  liked: boolean;
  likeCount?: number;
  commentCount?: number;
  onLike: () => void;
  onComment: () => void;
  onCopy: () => void;
  onMore: () => void;
  bottom?: number;
}) {
  return (
    <View style={[styles.rail, { bottom }]} pointerEvents="box-none">
      <Tool icon={liked ? "heart" : "heart-outline"} label={String(likeCount || "Like")} color={liked ? "#ff4d6d" : "#fff"} onPress={onLike} />
      <Tool icon="chatbubble-outline" label={String(commentCount || "Comment")} onPress={onComment} />
      <Tool icon="link-outline" label="Copy" onPress={onCopy} />
      <Tool icon="ellipsis-horizontal" label="More" onPress={onMore} />
    </View>
  );
}

function Tool({
  icon,
  label,
  color = "#fff",
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  color?: string;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={styles.tool} hitSlop={10}>
      <View style={styles.iconWrap}>
        <Ionicons name={icon} size={28} color={color} />
      </View>
      <Text style={styles.label}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  rail: {
    position: "absolute",
    right: 12,
    bottom: 88,
    alignItems: "center",
    gap: 18,
    zIndex: 4,
    elevation: 4,
  },
  tool: { alignItems: "center", gap: 4 },
  iconWrap: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: "#00000066",
    alignItems: "center",
    justifyContent: "center",
  },
  label: { color: "#fff", fontSize: 12, fontWeight: "600" },
});
