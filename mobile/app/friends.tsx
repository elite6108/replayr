import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { Button, Notice } from "@/components/ui";
import { useAuth } from "@/lib/auth";
import { formatDurationMs } from "@/lib/format";
import { shareClipUrl } from "@/lib/media";
import { clipShareUrl, getSupabase } from "@/lib/supabase";
import { colors } from "@/lib/theme";

interface ShareClip {
  id: string;
  title: string | null;
  slug: string;
  visibility: string;
  duration_ms: number | null;
}

export default function FriendsScreen() {
  const router = useRouter();
  const { session } = useAuth();
  const userId = session?.user.id ?? "";
  const [clips, setClips] = useState<ShareClip[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    void getSupabase()
      .from("clips")
      .select("id, title, slug, status, visibility, duration_ms")
      .eq("user_id", userId)
      .eq("status", "ready")
      .in("visibility", ["unlisted", "public"])
      .order("created_at", { ascending: false })
      .limit(8)
      .then(({ data }) => {
        if (!cancelled) setClips((data as ShareClip[]) ?? []);
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  return (
    <View style={styles.page}>
      <Text style={styles.title}>Share with people, not a feed</Text>
      <Text style={styles.muted}>
        Send an unlisted link. The watcher does not need an account. Follows, friend requests, and activity ship in Phase
        8 — they are not on this page yet.
      </Text>
      <Notice>{notice}</Notice>
      <Text style={styles.heading}>Copy a recent cloud clip</Text>
      {clips.length === 0 ? (
        <Text style={styles.muted}>No ready cloud clips yet. Upload from the Windows app, then share a link here.</Text>
      ) : (
        clips.map((clip) => (
          <View key={clip.id} style={styles.row}>
            <View style={styles.copy}>
              <Text style={styles.name}>{clip.title || "Untitled clip"}</Text>
              <Text style={styles.muted}>
                {clip.visibility}
                {clip.duration_ms ? ` · ${formatDurationMs(clip.duration_ms)}` : ""}
              </Text>
            </View>
            <Button
              label="Share"
              kind="primary"
              onPress={() => {
                void shareClipUrl(clipShareUrl(clip.slug)).then(() => setNotice("Link ready — they do not need an account."));
              }}
            />
          </View>
        ))
      )}
      <View style={styles.card}>
        <Text style={styles.heading}>Follows come later</Text>
        <Text style={styles.muted}>
          Requests, a friends list, and activity will wait for Phase 8. Until then, unlisted URLs are how you send a play
          to someone.
        </Text>
      </View>
      <Button label="Library" onPress={() => router.push("/library")} />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg, padding: 16, gap: 12 },
  title: { color: colors.text, fontSize: 24, fontWeight: "700" },
  heading: { color: colors.text, fontSize: 18, fontWeight: "700" },
  muted: { color: colors.muted, fontSize: 14, lineHeight: 20 },
  row: { flexDirection: "row", gap: 12, alignItems: "center" },
  copy: { flex: 1, gap: 4 },
  name: { color: colors.text, fontWeight: "600" },
  card: { backgroundColor: colors.raised, borderRadius: 12, padding: 14, gap: 8 },
});
