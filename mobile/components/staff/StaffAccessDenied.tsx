import { Pressable, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { AppHeader } from "@/components/AppHeader";
import { staffStyles } from "@/components/staff/staffStyles";
import { colors } from "@/lib/theme";

export function StaffAccessDenied({
  message = "Access denied. Staff membership is required.",
}: {
  message?: string;
}) {
  const router = useRouter();
  return (
    <SafeAreaView style={staffStyles.page} edges={["top"]}>
      <AppHeader padded />
      <View style={{ padding: 16, gap: 12 }}>
        <Text style={staffStyles.eyebrow}>Operations</Text>
        <Text style={staffStyles.title}>Access denied</Text>
        <Text style={staffStyles.muted}>{message}</Text>
        <Pressable onPress={() => router.replace("/account")}>
          <Text style={{ color: colors.accent, fontWeight: "700" }}>Back to Profile</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}
