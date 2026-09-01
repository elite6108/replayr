import { Stack } from "expo-router";
import { colors } from "@/lib/theme";

export default function FolderIdLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.bg },
      }}
    >
      <Stack.Screen name="index" />
      <Stack.Screen name="play" options={{ animation: "fade", contentStyle: { backgroundColor: "#000" } }} />
    </Stack>
  );
}
