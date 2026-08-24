import Ionicons from "@expo/vector-icons/Ionicons";
import { Tabs } from "expo-router";
import { Pressable, StyleSheet, View } from "react-native";
import { colors } from "@/lib/theme";
import { useSocialUnread } from "@/lib/socialUnread";

function CreateTabButton({
  onPress,
  accessibilityState,
}: {
  onPress?: () => void;
  accessibilityState?: { selected?: boolean };
}) {
  return (
    <Pressable
      onPress={() => onPress?.()}
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      accessibilityLabel="Create clip"
      style={styles.createWrap}
    >
      <View style={styles.createBtn}>
        <Ionicons name="add" size={30} color="#07080b" />
      </View>
    </Pressable>
  );
}

export default function TabLayout() {
  const { messagesUnread } = useSocialUnread();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        headerStyle: { backgroundColor: colors.bg },
        headerTintColor: colors.text,
        tabBarStyle: styles.tabBar,
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.muted,
        tabBarLabelStyle: { fontSize: 11, fontWeight: "600" },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Home",
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons name={focused ? "home" : "home-outline"} color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="library"
        options={{
          title: "Clips",
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons name={focused ? "play-circle" : "play-circle-outline"} color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="create"
        options={{
          title: "",
          tabBarLabel: () => null,
          tabBarButton: (props) => (
            <CreateTabButton onPress={() => props.onPress?.(undefined as never)} accessibilityState={props.accessibilityState} />
          ),
        }}
      />
      <Tabs.Screen
        name="games"
        options={{
          href: null,
          title: "Games",
        }}
      />
      <Tabs.Screen
        name="messages"
        options={{
          title: "Messages",
          tabBarIcon: ({ color, size, focused }) => (
            <View>
              <Ionicons name={focused ? "chatbubbles" : "chatbubbles-outline"} color={color} size={size} />
              {messagesUnread ? <View style={styles.pip} /> : null}
            </View>
          ),
        }}
      />
      <Tabs.Screen
        name="account"
        options={{
          title: "Profile",
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons name={focused ? "person" : "person-outline"} color={color} size={size} />
          ),
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  tabBar: {
    backgroundColor: colors.bg,
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    height: 64,
    paddingTop: 6,
  },
  createWrap: {
    top: -14,
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
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
