import Ionicons from "@expo/vector-icons/Ionicons";
import { usePathname, useRouter } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useSocialUnread } from "@/lib/socialUnread";
import { colors } from "@/lib/theme";

const HIDDEN = [/^\/c\//, /^\/signin/, /^\/auth\//];

export function shouldShowAppTabBar(pathname: string) {
  return !HIDDEN.some((pattern) => pattern.test(pathname));
}

export function AppTabBar() {
  const pathname = usePathname();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { messagesUnread } = useSocialUnread();

  if (!shouldShowAppTabBar(pathname)) return null;

  const homeOn = pathname === "/" || pathname === "/index";
  const clipsOn = pathname.startsWith("/library");
  const createOn = pathname.startsWith("/create");
  const messagesOn = pathname.startsWith("/messages");
  const profileOn = pathname.startsWith("/account") || pathname.startsWith("/settings");

  return (
    <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, 8) }]}>
      <TabItem
        label="Home"
        icon={homeOn ? "home" : "home-outline"}
        active={homeOn}
        onPress={() => router.navigate("/")}
      />
      <TabItem
        label="Clips"
        icon={clipsOn ? "play-circle" : "play-circle-outline"}
        active={clipsOn}
        onPress={() => router.navigate("/library")}
      />
      <Pressable
        onPress={() => router.navigate("/create")}
        accessibilityRole="button"
        accessibilityLabel="Create clip"
        style={styles.createWrap}
      >
        <View style={[styles.createBtn, createOn && styles.createOn]}>
          <Ionicons name="add" size={30} color="#07080b" />
        </View>
      </Pressable>
      <TabItem
        label="Messages"
        icon={messagesOn ? "chatbubbles" : "chatbubbles-outline"}
        active={messagesOn}
        pip={messagesUnread}
        onPress={() => router.navigate("/messages")}
      />
      <TabItem
        label="Profile"
        icon={profileOn ? "person" : "person-outline"}
        active={profileOn}
        onPress={() => router.navigate("/account")}
      />
    </View>
  );
}

function TabItem({
  label,
  icon,
  active,
  pip,
  onPress,
}: {
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  active: boolean;
  pip?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={styles.item} accessibilityRole="button" accessibilityState={{ selected: active }}>
      <View>
        <Ionicons name={icon} size={24} color={active ? colors.accent : colors.muted} />
        {pip ? <View style={styles.pip} /> : null}
      </View>
      <Text style={[styles.label, active && styles.labelOn]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-around",
    backgroundColor: colors.bg,
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 6,
    minHeight: 64,
  },
  item: { flex: 1, alignItems: "center", gap: 2, paddingBottom: 4 },
  label: { color: colors.muted, fontSize: 11, fontWeight: "600" },
  labelOn: { color: colors.accent },
  createWrap: { top: -14, flex: 1, alignItems: "center", justifyContent: "center" },
  createBtn: {
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: colors.accent,
    shadowOpacity: 0.55,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
    elevation: 10,
  },
  createOn: { opacity: 0.85 },
  pip: {
    position: "absolute",
    top: -2,
    right: -4,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.accent,
  },
});
