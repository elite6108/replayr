import { Stack } from "expo-router";
import { colors } from "@/lib/theme";

export default function FoldersLayout() {
  return (
    <Stack
      screenOptions={{
        headerTintColor: colors.accent,
        headerStyle: { backgroundColor: colors.raised },
        contentStyle: { backgroundColor: colors.bg },
      }}
    >
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="[id]" options={{ headerShown: false }} />
    </Stack>
  );
}
