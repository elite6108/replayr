import Ionicons from "@expo/vector-icons/Ionicons";
import { useRouter } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors, glowSm } from "@/lib/theme";

export function PlayerTopChrome({
  top,
  mode = "foryou",
}: {
  top: number;
  mode?: "foryou" | "following" | "single";
}) {
  const router = useRouter();
  const forYouOn = mode !== "following";
  const followingOn = mode === "following";

  return (
    <View style={[styles.wrap, { paddingTop: top + 4 }]} pointerEvents="box-none">
      <View style={styles.row}>
        <View style={styles.tabs}>
          <Pressable onPress={() => router.push("/")} hitSlop={8}>
            <Text style={[styles.tab, forYouOn && styles.tabOn]}>For You</Text>
            {forYouOn ? <View style={styles.tabUnderline} /> : null}
          </Pressable>
          <Pressable onPress={() => router.push("/friends")} hitSlop={8}>
            <Text style={[styles.tab, followingOn && styles.tabOn]}>Following</Text>
            {followingOn ? <View style={styles.tabUnderline} /> : null}
          </Pressable>
        </View>
        <Text style={styles.brand} pointerEvents="none">
          REPLAYR
        </Text>
        <Pressable
          style={styles.search}
          onPress={() => router.push("/search")}
          accessibilityRole="button"
          accessibilityLabel="Search"
          hitSlop={10}
        >
          <Ionicons name="search" size={22} color="#fff" />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 5,
    paddingHorizontal: 14,
  },
  row: {
    minHeight: 40,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  tabs: { flexDirection: "row", alignItems: "center", gap: 16, flex: 1 },
  tab: { color: "rgba(255,255,255,0.55)", fontSize: 15, fontWeight: "700" },
  tabOn: { color: "#fff", ...glowSm, textShadowColor: colors.accent, textShadowRadius: 8 },
  tabUnderline: {
    marginTop: 4,
    height: 2,
    borderRadius: 1,
    backgroundColor: colors.accent,
    ...glowSm,
  },
  brand: {
    position: "absolute",
    left: 0,
    right: 0,
    textAlign: "center",
    color: "#fff",
    fontSize: 13,
    fontWeight: "800",
    letterSpacing: 2.4,
  },
  search: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
  },
});
