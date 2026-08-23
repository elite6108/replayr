import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Redirect, useLocalSearchParams } from "expo-router";
import { Notice } from "@/components/ui";
import { useAuth } from "@/lib/auth";
import { getSupabase, supabaseConfigured } from "@/lib/supabase";
import { colors } from "@/lib/theme";

export default function AuthCallbackScreen() {
  const { session } = useAuth();
  const params = useLocalSearchParams<{ code?: string; error?: string; error_description?: string }>();
  const [error, setError] = useState<string | null>(params.error_description || params.error || null);

  useEffect(() => {
    if (error || !params.code || !supabaseConfigured() || session) return;
    const timer = setTimeout(() => {
      if (session) return;
      void getSupabase()
        .auth.exchangeCodeForSession(params.code as string)
        .then(({ error: next }) => {
          if (next) setError(next.message);
        });
    }, 400);
    return () => clearTimeout(timer);
  }, [error, params.code, session]);

  if (session) return <Redirect href="/library" />;

  return (
    <View style={styles.page}>
      <Text style={styles.title}>Signing in</Text>
      {error ? <Notice tone="danger">{error}</Notice> : <Text style={styles.muted}>Finishing sign-in…</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg, padding: 16, gap: 12, justifyContent: "center" },
  title: { color: colors.text, fontSize: 24, fontWeight: "700" },
  muted: { color: colors.muted, fontSize: 15 },
});
