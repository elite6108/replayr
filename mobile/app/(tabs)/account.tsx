import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "@/components/ui";
import { UserProfileView } from "@/components/UserProfileView";
import { useAuth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { colors } from "@/lib/theme";

export default function AccountScreen() {
  const router = useRouter();
  const { session } = useAuth();
  const userId = session?.user.id ?? "";
  const [username, setUsername] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(session));

  useEffect(() => {
    if (!userId) {
      setUsername(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void getSupabase()
      .from("profiles")
      .select("username")
      .eq("id", userId)
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          setUsername(null);
        } else {
          setUsername((data as { username: string | null } | null)?.username ?? null);
        }
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const header = (
    <View style={styles.topBar}>
      <Text style={styles.topTitle}>Profile</Text>
      {session ? (
        <Pressable onPress={() => router.push("/settings")} hitSlop={8} accessibilityLabel="Settings">
          <Ionicons name="settings-outline" size={24} color={colors.text} />
        </Pressable>
      ) : (
        <View style={styles.topSpacer} />
      )}
    </View>
  );

  if (session === undefined || loading) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        {header}
      </SafeAreaView>
    );
  }

  if (!session) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        {header}
        <View style={styles.center}>
          <Text style={styles.lede}>Same Replayr identity as the Windows app and website.</Text>
          <Button label="Sign in" kind="primary" onPress={() => router.push("/signin")} />
        </View>
      </SafeAreaView>
    );
  }

  if (!username) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        {header}
        <View style={styles.center}>
          <Text style={styles.lede}>Choose a username in the desktop app to publish your public profile and posts.</Text>
          <Button label="Open settings" onPress={() => router.push("/settings")} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      {header}
      <UserProfileView username={username} hideOwnActions />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  topTitle: { color: colors.text, fontSize: 28, fontWeight: "800" },
  topSpacer: { width: 24, height: 24 },
  center: { flex: 1, paddingHorizontal: 16, gap: 12, justifyContent: "center" },
  lede: { color: colors.muted, fontSize: 15, lineHeight: 22 },
});
