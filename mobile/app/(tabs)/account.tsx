import { useEffect, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import * as Linking from "expo-linking";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button, Notice } from "@/components/ui";
import { deleteAccount } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatBytes } from "@/lib/format";
import { getSupabase } from "@/lib/supabase";
import { colors } from "@/lib/theme";

interface ProfileRow {
  username: string | null;
  display_name: string | null;
}

interface Quota {
  storage_used_bytes: number;
  storage_limit_bytes: number;
}

export default function AccountScreen() {
  const router = useRouter();
  const { session, signOut } = useAuth();
  const userId = session?.user.id ?? "";
  const [profile, setProfile] = useState<ProfileRow | null>(null);
  const [quota, setQuota] = useState<Quota | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    void (async () => {
      const supabase = getSupabase();
      const [profileResult, quotaResult] = await Promise.all([
        supabase.from("profiles").select("username, display_name").eq("id", userId).maybeSingle(),
        supabase.from("user_storage").select("storage_used_bytes, storage_limit_bytes").eq("user_id", userId).maybeSingle(),
      ]);
      if (cancelled) return;
      if (profileResult.error) setError(profileResult.error.message);
      else setProfile(profileResult.data as ProfileRow | null);
      if (!quotaResult.error && quotaResult.data) setQuota(quotaResult.data as Quota);
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  function confirmDelete() {
    Alert.alert(
      "Delete this account?",
      "Removes your Replayr login, cloud clips, and quota. Local files on Windows stay until you delete them there.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete account",
          style: "destructive",
          onPress: () => {
            Alert.alert("This cannot be undone.", "Delete the account and all cloud clips?", [
              { text: "Cancel", style: "cancel" },
              { text: "Delete forever", style: "destructive", onPress: () => void onDelete() },
            ]);
          },
        },
      ],
    );
  }

  async function onDelete() {
    if (!session?.access_token) return;
    setBusy(true);
    setError(null);
    try {
      await deleteAccount(session.access_token);
      await signOut();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not delete this account.");
    } finally {
      setBusy(false);
    }
  }

  if (session === undefined) {
    return (
      <SafeAreaView style={styles.center} edges={["top"]}>
        <Text style={styles.muted}>Loading…</Text>
      </SafeAreaView>
    );
  }

  if (!session) {
    return (
      <SafeAreaView style={styles.center} edges={["top"]}>
        <Text style={styles.title}>Account</Text>
        <Text style={styles.muted}>Same Replayr identity as the Windows app and website.</Text>
        <Button label="Sign in" kind="primary" onPress={() => router.push("/signin")} />
      </SafeAreaView>
    );
  }

  const used = quota?.storage_used_bytes ?? 0;
  const limit = quota?.storage_limit_bytes ?? 0;
  const percent = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;

  return (
    <SafeAreaView style={styles.page} edges={["top"]}>
      <Text style={styles.title}>Account</Text>
      <Text style={styles.muted}>Same identity as the Windows app. Capture still happens on the PC.</Text>
      <Notice tone="danger">{error}</Notice>
      <View style={styles.meta}>
        <Text style={styles.label}>Email</Text>
        <Text style={styles.value}>{session.user.email}</Text>
        <Text style={styles.label}>Username</Text>
        <Text style={styles.value}>{profile?.username || "Not set yet — choose one in the desktop app."}</Text>
        <Text style={styles.label}>Display name</Text>
        <Text style={styles.value}>{profile?.display_name || "—"}</Text>
      </View>
      {quota ? (
        <View style={styles.quota}>
          <View style={styles.bar}>
            <View style={[styles.fill, { width: `${percent}%` }]} />
          </View>
          <Text style={styles.muted}>
            {formatBytes(used)} of {formatBytes(limit)} cloud storage used
          </Text>
        </View>
      ) : null}
      <Button label="Friends" onPress={() => router.push("/friends")} />
      <Button label="Sign out" onPress={() => void signOut()} />
      <Button label={busy ? "Deleting…" : "Delete account"} kind="danger" disabled={busy} onPress={confirmDelete} />
      <Pressable onPress={() => void Linking.openURL("https://www.replayr.tv/privacy")}>
        <Text style={styles.link}>Privacy</Text>
      </Pressable>
      <Pressable onPress={() => void Linking.openURL("https://www.replayr.tv/terms")}>
        <Text style={styles.link}>Terms</Text>
      </Pressable>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg, padding: 16, gap: 12 },
  center: { flex: 1, backgroundColor: colors.bg, padding: 16, gap: 12, justifyContent: "center" },
  title: { color: colors.text, fontSize: 28, fontWeight: "700" },
  muted: { color: colors.muted, fontSize: 14, lineHeight: 20 },
  meta: { gap: 6, paddingVertical: 8 },
  label: { color: colors.muted, fontSize: 13 },
  value: { color: colors.text, fontSize: 16, marginBottom: 8 },
  quota: { gap: 8 },
  bar: { height: 8, backgroundColor: colors.raised, borderRadius: 8, overflow: "hidden" },
  fill: { height: 8, backgroundColor: colors.accent },
  link: { color: colors.accent, fontSize: 15 },
});
