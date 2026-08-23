import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { Avatar } from "@/components/Avatar";
import { ClipThumb } from "@/components/ClipThumb";
import { CommentsSheet } from "@/components/CommentsSheet";
import { GameCover } from "@/components/GameCover";
import {
  fetchFavoriteGames,
  fetchGames,
  fetchLibrary,
  fetchOwnProfile,
  fetchPublicClips,
  setClipLiked,
  type CatalogGame,
  type ManagedClip,
  type PublicClipCard,
} from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatCount, formatDurationMs, formatHandle } from "@/lib/format";
import { shareClipUrl } from "@/lib/media";
import { clipShareUrl } from "@/lib/supabase";
import { colors } from "@/lib/theme";

export default function HomeScreen() {
  const router = useRouter();
  const { width } = useWindowDimensions();
  const { session } = useAuth();
  const token = session?.access_token;
  const userId = session?.user.id;
  const cardWidth = Math.floor((width - 16 * 2 - 12) / 2);
  const [mine, setMine] = useState<ManagedClip[]>([]);
  const [games, setGames] = useState<CatalogGame[]>([]);
  const [feed, setFeed] = useState<PublicClipCard[]>([]);
  const [profile, setProfile] = useState<{ username: string | null; display_name: string | null; avatar_url: string | null } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [commentSlug, setCommentSlug] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [publicClips, catalog] = await Promise.all([
      fetchPublicClips(token).catch(() => [] as PublicClipCard[]),
      fetchGames().catch(() => [] as CatalogGame[]),
    ]);
    setFeed(publicClips);
    if (token && userId) {
      const [library, favorites, own] = await Promise.all([
        fetchLibrary(token, { page: 1, limit: 12 }).catch(() => ({ clips: [] })),
        fetchFavoriteGames(userId).catch(() => [] as CatalogGame[]),
        fetchOwnProfile(userId).catch(() => null),
      ]);
      setMine(library.clips.filter((clip) => clip.status === "ready"));
      setGames(favorites.length > 0 ? favorites.slice(0, 8) : catalog.filter((game) => game.coverUrl).slice(0, 8));
      setProfile(own);
    } else {
      setMine([]);
      setGames(catalog.filter((game) => game.coverUrl).slice(0, 8));
      setProfile(null);
    }
  }, [token, userId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggleLike(clip: PublicClipCard) {
    if (!token) {
      router.push("/signin");
      return;
    }
    const nextLiked = !clip.liked;
    setFeed((current) =>
      current.map((item) =>
        item.id === clip.id
          ? { ...item, liked: nextLiked, likeCount: Math.max(0, item.likeCount + (nextLiked ? 1 : -1)) }
          : item,
      ),
    );
    try {
      const result = await setClipLiked(clip.slug, nextLiked, token);
      setFeed((current) =>
        current.map((item) =>
          item.id === clip.id ? { ...item, liked: result.liked, likeCount: result.likeCount } : item,
        ),
      );
    } catch {
      setFeed((current) =>
        current.map((item) =>
          item.id === clip.id
            ? { ...item, liked: clip.liked, likeCount: clip.likeCount }
            : item,
        ),
      );
    }
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <ScrollView
        style={styles.page}
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            tintColor={colors.accent}
            onRefresh={() => {
              setRefreshing(true);
              void load().finally(() => setRefreshing(false));
            }}
          />
        }
      >
        <View style={styles.header}>
          <Text style={styles.brand}>Replayr</Text>
          <Pressable onPress={() => router.push(session ? "/account" : "/signin")}>
            <Avatar name={profile?.display_name || profile?.username || session?.user.email} uri={profile?.avatar_url} size={36} />
          </Pressable>
        </View>

        <Section title="My Latest Clips" action="See All" onAction={() => router.push("/library")}>
          {session ? (
            mine.length > 0 ? (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.rail}>
                {mine.map((clip) => (
                  <Pressable key={clip.id} style={styles.latest} onPress={() => router.push(`/c/${clip.slug}?clipId=${clip.id}`)}>
                    <View>
                      <ClipThumb title={clip.title || "Clip"} thumbnailUrl={clip.thumbnailUrl} />
                      <View style={styles.play}>
                        <Ionicons name="play" size={16} color="#fff" />
                      </View>
                      {clip.durationMs ? <Text style={styles.duration}>{formatDurationMs(clip.durationMs)}</Text> : null}
                    </View>
                    <Text style={styles.cardTitle} numberOfLines={2}>
                      {clip.title || "Untitled clip"}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
            ) : (
              <Text style={styles.muted}>Clips you upload from Windows show up here.</Text>
            )
          ) : (
            <Pressable onPress={() => router.push("/signin")}>
              <Text style={styles.link}>Sign in to see your latest clips.</Text>
            </Pressable>
          )}
        </Section>

        {games.length > 0 ? (
          <Section title="Favorite Games" action="Shortcut" onAction={() => router.push("/games")}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.rail}>
              {games.map((game) => (
                <Pressable key={game.id} style={styles.game} onPress={() => router.push(`/games/${game.slug}`)}>
                  <GameCover name={game.name} coverUrl={game.coverUrl} round size={72} />
                  <Text style={styles.gameName} numberOfLines={1}>
                    {game.name}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          </Section>
        ) : null}

        <Section title="For You">
          {feed.length === 0 ? (
            <Text style={styles.muted}>When someone makes a clip public, it lands here. Unlisted links never appear.</Text>
          ) : (
            <View style={styles.grid}>
              {feed.map((clip) => (
                <View key={clip.id} style={[styles.feedCard, { width: cardWidth }]}>
                  <View style={styles.feedHead}>
                    <Avatar name={clip.author.displayName || clip.author.username} uri={clip.author.avatarUrl} size={22} />
                    <Text style={styles.handle} numberOfLines={1}>
                      {formatHandle(clip.author)}
                    </Text>
                  </View>
                  <Text style={styles.feedTitle} numberOfLines={2}>
                    {clip.title || "Untitled clip"}
                  </Text>
                  <Pressable onPress={() => router.push(`/c/${clip.slug}`)}>
                    <ClipThumb title={clip.title || "Clip"} thumbnailUrl={clip.thumbnailUrl} />
                    <View style={styles.playCenter}>
                      <Ionicons name="play" size={18} color="#fff" />
                    </View>
                    {clip.durationMs ? <Text style={styles.duration}>{formatDurationMs(clip.durationMs)}</Text> : null}
                  </Pressable>
                  <View style={styles.actions}>
                    <Pressable style={styles.action} onPress={() => void toggleLike(clip)}>
                      <Ionicons name={clip.liked ? "heart" : "heart-outline"} size={16} color={clip.liked ? colors.like : colors.text} />
                      <Text style={styles.actionText}>{formatCount(clip.likeCount)}</Text>
                    </Pressable>
                    <Pressable style={styles.action} onPress={() => setCommentSlug(clip.slug)}>
                      <Ionicons name="chatbubble-outline" size={15} color={colors.text} />
                      <Text style={styles.actionText}>{formatCount(clip.commentCount)}</Text>
                    </Pressable>
                    <Pressable style={styles.action} onPress={() => void shareClipUrl(clipShareUrl(clip.slug))}>
                      <Ionicons name="arrow-redo-outline" size={16} color={colors.text} />
                      <Text style={styles.actionText}>Share</Text>
                    </Pressable>
                  </View>
                </View>
              ))}
            </View>
          )}
        </Section>
      </ScrollView>
      <CommentsSheet
        slug={commentSlug ?? ""}
        visible={Boolean(commentSlug)}
        token={token}
        onClose={() => setCommentSlug(null)}
        onCount={(count) => {
          if (!commentSlug) return;
          setFeed((current) =>
            current.map((item) => (item.slug === commentSlug ? { ...item, commentCount: count } : item)),
          );
        }}
      />
    </SafeAreaView>
  );
}

function Section({
  title,
  action,
  onAction,
  children,
}: {
  title: string;
  action?: string;
  onAction?: () => void;
  children: ReactNode;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHead}>
        <Text style={styles.heading}>{title}</Text>
        {action ? (
          <Pressable onPress={onAction}>
            <Text style={styles.link}>{action}</Text>
          </Pressable>
        ) : null}
      </View>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  page: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, gap: 22, paddingBottom: 40 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  brand: { color: colors.text, fontSize: 28, fontWeight: "800" },
  section: { gap: 12 },
  sectionHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  heading: { color: colors.text, fontSize: 20, fontWeight: "700" },
  link: { color: colors.accent, fontWeight: "600" },
  muted: { color: colors.muted, fontSize: 14, lineHeight: 20 },
  rail: { gap: 12, paddingRight: 8 },
  latest: { width: 168, gap: 8 },
  cardTitle: { color: colors.text, fontWeight: "600" },
  duration: {
    position: "absolute",
    right: 8,
    bottom: 8,
    color: "#fff",
    backgroundColor: "#000000aa",
    paddingHorizontal: 6,
    borderRadius: 4,
    overflow: "hidden",
    fontSize: 12,
  },
  play: {
    position: "absolute",
    left: "50%",
    top: "50%",
    marginLeft: -14,
    marginTop: -14,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: "#00000088",
    alignItems: "center",
    justifyContent: "center",
  },
  playCenter: {
    position: "absolute",
    left: "50%",
    top: "50%",
    marginLeft: -16,
    marginTop: -16,
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: "#00000088",
    alignItems: "center",
    justifyContent: "center",
  },
  game: { width: 80, alignItems: "center", gap: 8 },
  gameName: { color: colors.text, fontSize: 12, textAlign: "center" },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  feedCard: { backgroundColor: colors.card, borderRadius: 14, padding: 10, gap: 8 },
  feedHead: { flexDirection: "row", alignItems: "center", gap: 6 },
  handle: { color: colors.text, fontSize: 12, fontWeight: "600", flex: 1 },
  feedTitle: { color: colors.text, fontWeight: "700", fontSize: 13 },
  actions: { flexDirection: "row", alignItems: "center", gap: 10 },
  action: { flexDirection: "row", alignItems: "center", gap: 4 },
  actionText: { color: colors.text, fontSize: 12, fontWeight: "600" },
});
