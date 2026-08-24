import { useEffect, useMemo, useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { GameCover } from "@/components/GameCover";
import { Notice } from "@/components/ui";
import { fetchGames, type CatalogGame } from "@/lib/api";
import { colors } from "@/lib/theme";

export default function GamesScreen() {
  const router = useRouter();
  const [games, setGames] = useState<CatalogGame[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void fetchGames()
      .then(setGames)
      .catch((caught) => setError(caught instanceof Error ? caught.message : "Could not load games."));
  }, []);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return games;
    return games.filter((game) => `${game.name} ${game.publisher ?? ""} ${game.slug}`.toLowerCase().includes(needle));
  }, [games, query]);

  return (
    <SafeAreaView style={styles.page} edges={["top"]}>
      <FlatList
        style={styles.page}
        contentContainerStyle={styles.list}
        data={visible}
        keyExtractor={(game) => game.id}
        numColumns={2}
        columnWrapperStyle={styles.columns}
        ListHeaderComponent={
          <View style={styles.header}>
            <Text style={styles.title}>Games</Text>
            <Text style={styles.muted}>Public clips only. Unlisted uploads never appear here.</Text>
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Search games"
              placeholderTextColor={colors.muted}
              style={styles.input}
            />
            <Notice tone="danger">{error}</Notice>
            {games.length === 0 && !error ? <Text style={styles.muted}>Loading games…</Text> : null}
            {games.length > 0 && visible.length === 0 ? <Text style={styles.muted}>No games match that search.</Text> : null}
          </View>
        }
        renderItem={({ item: game }) => (
          <Pressable style={styles.card} onPress={() => router.push(`/games/${game.slug}`)}>
            <GameCover name={game.name} coverUrl={game.coverUrl} />
            <Text style={styles.name} numberOfLines={2}>
              {game.name}
            </Text>
            {game.publisher ? <Text style={styles.muted}>{game.publisher}</Text> : null}
          </Pressable>
        )}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg },
  list: { padding: 12, paddingBottom: 40 },
  header: { gap: 8, marginBottom: 12 },
  title: { color: colors.text, fontSize: 28, fontWeight: "700" },
  muted: { color: colors.muted, fontSize: 14, lineHeight: 20 },
  input: {
    backgroundColor: colors.raised,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    color: colors.text,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  columns: { gap: 12 },
  card: { flex: 1, gap: 8, marginBottom: 16 },
  name: { color: colors.text, fontWeight: "600" },
});
