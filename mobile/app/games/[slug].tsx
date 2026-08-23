import { useEffect, useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ClipThumb } from "@/components/ClipThumb";
import { GameCover } from "@/components/GameCover";
import { Notice } from "@/components/ui";
import { fetchGameClips, type CatalogGame, type PublicGameClip } from "@/lib/api";
import { formatDurationMs } from "@/lib/format";
import { colors } from "@/lib/theme";

export default function GameScreen() {
  const router = useRouter();
  const { slug = "" } = useLocalSearchParams<{ slug: string }>();
  const [game, setGame] = useState<CatalogGame | null>(null);
  const [clips, setClips] = useState<PublicGameClip[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setGame(null);
    setClips([]);
    setError(null);
    void fetchGameClips(slug)
      .then((next) => {
        if (cancelled) return;
        setGame(next.game);
        setClips(next.clips);
      })
      .catch((caught) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Could not load this game.");
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  return (
    <FlatList
      style={styles.page}
      contentContainerStyle={styles.list}
      data={clips}
      keyExtractor={(clip) => clip.id}
      numColumns={2}
      columnWrapperStyle={styles.columns}
      ListHeaderComponent={
        <View style={styles.header}>
          {game ? (
            <View style={styles.hero}>
              <View style={styles.cover}>
                <GameCover name={game.name} coverUrl={game.coverUrl} />
              </View>
              <View style={styles.heroCopy}>
                <Text style={styles.muted}>{game.publisher || "Catalog"}</Text>
                <Text style={styles.title}>{game.name}</Text>
                <Text style={styles.muted}>Public clips only. Unlisted and private uploads stay off this page.</Text>
              </View>
            </View>
          ) : !error ? (
            <Text style={styles.muted}>Loading game…</Text>
          ) : null}
          <Notice tone="danger">{error}</Notice>
          {game && clips.length === 0 ? <Text style={styles.muted}>No public clips yet.</Text> : null}
        </View>
      }
      renderItem={({ item: clip }) => (
        <Pressable style={styles.card} onPress={() => router.push(`/c/${clip.slug}`)}>
          <ClipThumb title={clip.title || "Clip"} thumbnailUrl={clip.thumbnailUrl} />
          {clip.durationMs ? <Text style={styles.duration}>{formatDurationMs(clip.durationMs)}</Text> : null}
          <Text style={styles.name} numberOfLines={2}>
            {clip.title || "Untitled clip"}
          </Text>
        </Pressable>
      )}
    />
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg },
  list: { padding: 12, paddingBottom: 40 },
  header: { gap: 12, marginBottom: 12 },
  hero: { flexDirection: "row", gap: 12 },
  cover: { width: 96 },
  heroCopy: { flex: 1, gap: 6, justifyContent: "center" },
  title: { color: colors.text, fontSize: 24, fontWeight: "700" },
  muted: { color: colors.muted, fontSize: 14, lineHeight: 20 },
  columns: { gap: 12 },
  card: { flex: 1, gap: 8, marginBottom: 16 },
  name: { color: colors.text, fontWeight: "600" },
  duration: {
    position: "absolute",
    right: 8,
    bottom: 36,
    color: colors.text,
    backgroundColor: "#000000aa",
    paddingHorizontal: 6,
    borderRadius: 4,
    overflow: "hidden",
    fontSize: 12,
  },
});
