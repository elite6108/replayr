import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { Avatar } from "@/components/Avatar";
import { GameCover } from "@/components/GameCover";
import { Button, Notice } from "@/components/ui";
import { fetchGames, type CatalogGame } from "@/lib/api";
import {
  fetchUserSuggestions,
  searchUsers,
  socialHandle,
  socialName,
  type Relationship,
  type SocialUser,
} from "@/lib/api.friends";
import { useAuth } from "@/lib/auth";
import { colors } from "@/lib/theme";

type Tab = "people" | "games";
type SearchHit = SocialUser & { relationship: Relationship };

const TABS: { id: Tab; label: string }[] = [
  { id: "people", label: "People" },
  { id: "games", label: "Games" },
];

export default function SearchScreen() {
  const router = useRouter();
  const { session } = useAuth();
  const token = session?.access_token;
  const [tab, setTab] = useState<Tab>("people");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchHit[]>([]);
  const [suggestions, setSuggestions] = useState<SearchHit[]>([]);
  const [games, setGames] = useState<CatalogGame[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void fetchGames()
      .then(setGames)
      .catch((caught) => setError(caught instanceof Error ? caught.message : "Could not load games."));
  }, []);

  useEffect(() => {
    if (!token || tab !== "people") return;
    const needle = query.trim();
    if (needle.length < 2) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const handle = setTimeout(() => {
      void searchUsers(token, needle)
        .then(setResults)
        .catch((caught) => setError(caught instanceof Error ? caught.message : "Could not search accounts."))
        .finally(() => setSearching(false));
    }, 280);
    return () => clearTimeout(handle);
  }, [query, tab, token]);

  useEffect(() => {
    if (!token || tab !== "people") return;
    if (query.trim().length >= 2) return;
    let cancelled = false;
    void fetchUserSuggestions(token)
      .then((users) => {
        if (!cancelled) setSuggestions(users);
      })
      .catch(() => {
        if (!cancelled) setSuggestions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [tab, token, query]);

  const visibleGames = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return games.slice(0, 40);
    return games.filter((game) => `${game.name} ${game.publisher ?? ""} ${game.slug}`.toLowerCase().includes(needle));
  }, [games, query]);

  const people = query.trim().length >= 2 ? results : suggestions;

  return (
    <View style={styles.page}>
      <View style={styles.tabs}>
        {TABS.map((item) => {
          const active = tab === item.id;
          return (
            <Pressable key={item.id} style={[styles.tab, active && styles.tabOn]} onPress={() => setTab(item.id)}>
              <Text style={[styles.tabLabel, active && styles.tabLabelOn]}>{item.label}</Text>
            </Pressable>
          );
        })}
      </View>
      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder={tab === "people" ? "Search by username" : "Search games"}
        placeholderTextColor={colors.muted}
        autoCapitalize="none"
        autoCorrect={false}
        autoFocus
        style={styles.input}
      />
      <Notice tone="danger">{error}</Notice>
      {tab === "people" ? (
        !session ? (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>Sign in to find people</Text>
            <Text style={styles.muted}>User search uses the same Replayr identity as the Windows app.</Text>
            <Button label="Sign in" kind="primary" onPress={() => router.push("/signin")} />
          </View>
        ) : (
          <FlatList
            data={people}
            keyExtractor={(item) => item.id}
            contentContainerStyle={styles.list}
            ListHeaderComponent={
              searching ? <ActivityIndicator color={colors.accent} /> : query.trim().length < 2 && suggestions.length > 0 ? (
                <Text style={styles.name}>Plays the same games</Text>
              ) : null
            }
            ListEmptyComponent={
              query.trim().length >= 2 && !searching ? (
                <Text style={styles.muted}>No accounts match that username.</Text>
              ) : (
                <Text style={styles.muted}>Type at least two characters, or add someone who plays the same games.</Text>
              )
            }
            renderItem={({ item }) => (
              <Pressable
                style={styles.row}
                onPress={() => {
                  if (item.username) router.push(`/u/${item.username}`);
                }}
              >
                <Avatar name={socialName(item)} uri={item.avatarUrl} size={44} />
                <View style={styles.copy}>
                  <Text style={styles.name}>{socialName(item)}</Text>
                  {socialHandle(item) ? <Text style={styles.muted}>{socialHandle(item)}</Text> : null}
                </View>
              </Pressable>
            )}
          />
        )
      ) : (
        <FlatList
          data={visibleGames}
          keyExtractor={(game) => game.id}
          numColumns={2}
          columnWrapperStyle={styles.columns}
          contentContainerStyle={styles.list}
          ListEmptyComponent={<Text style={styles.muted}>No games match that search.</Text>}
          renderItem={({ item: game }) => (
            <Pressable style={styles.game} onPress={() => router.push(`/games/${game.slug}`)}>
              <GameCover name={game.name} coverUrl={game.coverUrl} />
              <Text style={styles.gameName} numberOfLines={2}>
                {game.name}
              </Text>
            </Pressable>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg, paddingHorizontal: 16, paddingTop: 12, gap: 12 },
  tabs: {
    flexDirection: "row",
    backgroundColor: colors.raised,
    borderRadius: 22,
    padding: 4,
    gap: 4,
  },
  tab: { flex: 1, borderRadius: 18, paddingVertical: 8, alignItems: "center" },
  tabOn: { backgroundColor: colors.accent },
  tabLabel: { color: colors.muted, fontWeight: "700", fontSize: 13 },
  tabLabelOn: { color: colors.onAccent },
  input: {
    backgroundColor: colors.raised,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 12,
    color: colors.text,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
  },
  muted: { color: colors.muted, fontSize: 14, lineHeight: 20 },
  list: { paddingBottom: 32, gap: 4 },
  empty: { gap: 12, paddingTop: 24 },
  emptyTitle: { color: colors.text, fontSize: 20, fontWeight: "700" },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10 },
  copy: { flex: 1, gap: 2 },
  name: { color: colors.text, fontWeight: "700", fontSize: 16 },
  columns: { gap: 12 },
  game: { flex: 1, gap: 8, marginBottom: 12 },
  gameName: { color: colors.text, fontSize: 13, fontWeight: "700" },
});
