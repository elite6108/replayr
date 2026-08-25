import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  NativeSyntheticEvent,
  NativeScrollEvent,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { Image } from "expo-image";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useFocusEffect, useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { Avatar } from "@/components/Avatar";
import { ClipThumb } from "@/components/ClipThumb";
import { CommentsSheet } from "@/components/CommentsSheet";
import { GameCover } from "@/components/GameCover";
import { NotificationsSheet } from "@/components/NotificationsSheet";
import {
  attachPublicClipCounts,
  fetchFavoriteGames,
  fetchFriendClips,
  fetchGames,
  fetchBillingStatus,
  fetchOwnProfile,
  fetchPublicClips,
  setClipLiked,
  type CatalogGame,
  type PublicClipCard,
} from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatCount, formatDurationMs, formatHandle, formatTimeAgo } from "@/lib/format";
import { shareClipUrl } from "@/lib/media";
import { clipShareUrl } from "@/lib/supabase";
import { colors, gameGlow } from "@/lib/theme";
import { listContinueWatching, type WatchItem } from "@/lib/watchProgress";
import { useSocialUnread } from "@/lib/socialUnread";

export default function HomeScreen() {
  const router = useRouter();
  const { width } = useWindowDimensions();
  const { session } = useAuth();
  const token = session?.access_token;
  const userId = session?.user.id;
  const featuredWidth = Math.max(280, width - 32);
  const [featured, setFeatured] = useState<PublicClipCard[]>([]);
  const [featuredIndex, setFeaturedIndex] = useState(0);
  const [continueWatching, setContinueWatching] = useState<WatchItem[]>([]);
  const [friendClips, setFriendClips] = useState<PublicClipCard[] | null>(null);
  const [games, setGames] = useState<CatalogGame[]>([]);
  const [feed, setFeed] = useState<PublicClipCard[]>([]);
  const [profile, setProfile] = useState<{ username: string | null; display_name: string | null; avatar_url: string | null } | null>(
    null,
  );
  const [refreshing, setRefreshing] = useState(false);
  const [commentSlug, setCommentSlug] = useState<string | null>(null);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [showAd, setShowAd] = useState(true);
  const { notificationsUnread } = useSocialUnread();

  const load = useCallback(async () => {
    const [trending, latest, catalog, history] = await Promise.all([
      fetchPublicClips(token, { limit: 8, sort: "trending" }).catch(() => [] as PublicClipCard[]),
      fetchPublicClips(token, { limit: 24 }).catch(() => [] as PublicClipCard[]),
      fetchGames().catch(() => [] as CatalogGame[]),
      listContinueWatching().catch(() => [] as WatchItem[]),
    ]);
    const featuredIds = new Set(trending.map((clip) => clip.id));
    setFeatured(trending);
    setFeaturedIndex(0);
    setFeed(latest.length > trending.length ? latest.filter((clip) => !featuredIds.has(clip.id)) : latest);
    setContinueWatching(history);
    if (token && userId) {
      const [favorites, own, fromFriends] = await Promise.all([
        fetchFavoriteGames(userId).catch(() => [] as CatalogGame[]),
        fetchOwnProfile(userId).catch(() => null),
        fetchFriendClips(token).catch(() => [] as PublicClipCard[]),
      ]);
      const nextGames = favorites.length > 0 ? favorites.slice(0, 8) : catalog.filter((game) => game.coverUrl).slice(0, 8);
      setGames(favorites.length > 0 ? nextGames : await attachPublicClipCounts(nextGames));
      setProfile(own);
      setFriendClips(fromFriends);
    } else {
      setGames(await attachPublicClipCounts(catalog.filter((game) => game.coverUrl).slice(0, 8)));
      setProfile(null);
      setFriendClips([]);
    }
  }, [token, userId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!token) {
      setShowAd(true);
      return;
    }
    void fetchBillingStatus(token)
      .then((status) => setShowAd(status.ads))
      .catch(() => setShowAd(true));
  }, [token]);

  useFocusEffect(
    useCallback(() => {
      void listContinueWatching().then(setContinueWatching).catch(() => undefined);
    }, []),
  );

  async function toggleLike(clip: PublicClipCard) {
    if (!token) {
      router.push("/signin");
      return;
    }
    const nextLiked = !clip.liked;
    const patch = (item: PublicClipCard) =>
      item.id === clip.id
        ? { ...item, liked: nextLiked, likeCount: Math.max(0, item.likeCount + (nextLiked ? 1 : -1)) }
        : item;
    setFeed((current) => current.map(patch));
    setFeatured((current) => current.map(patch));
    try {
      const result = await setClipLiked(clip.slug, nextLiked, token);
      const apply = (item: PublicClipCard) =>
        item.id === clip.id ? { ...item, liked: result.liked, likeCount: result.likeCount } : item;
      setFeed((current) => current.map(apply));
      setFeatured((current) => current.map(apply));
    } catch {
      const revert = (item: PublicClipCard) =>
        item.id === clip.id ? { ...item, liked: clip.liked, likeCount: clip.likeCount } : item;
      setFeed((current) => current.map(revert));
      setFeatured((current) => current.map(revert));
    }
  }

  function openClip(slug: string) {
    router.push(`/c/${slug}`);
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
          <Image
            source={require("../../assets/images/replayr-logo.png")}
            style={styles.brandLogo}
            contentFit="contain"
            accessibilityLabel="Replayr"
          />
          <View style={styles.headerActions}>
            <Pressable style={styles.bell} onPress={() => router.push("/search")} hitSlop={8}>
              <Ionicons name="search" size={20} color={colors.text} />
            </Pressable>
            <Pressable
              style={styles.bell}
              onPress={() => {
                if (!session) {
                  router.push("/signin");
                  return;
                }
                setNotificationsOpen(true);
              }}
              hitSlop={8}
            >
              <Ionicons name="notifications-outline" size={22} color={colors.text} />
              {notificationsUnread > 0 ? <View style={styles.bellPip} /> : null}
            </Pressable>
            <Pressable onPress={() => router.push(session ? "/account" : "/signin")}>
              <Avatar name={profile?.display_name || profile?.username || session?.user.email} uri={profile?.avatar_url} size={36} />
            </Pressable>
          </View>
        </View>

        {showAd ? (
          <Pressable style={styles.houseAd} onPress={() => router.push("/account")}>
            <Text style={styles.houseAdTitle}>Replayr Premium — $4.99/mo</Text>
            <Text style={styles.houseAdCopy}>100 GB, original uploads, and no Replayr.tv watermark.</Text>
          </Pressable>
        ) : null}

        {featured.length > 0 ? (
          <View style={styles.featuredBlock}>
            <ScrollView
              horizontal
              pagingEnabled
              decelerationRate="fast"
              showsHorizontalScrollIndicator={false}
              onMomentumScrollEnd={(event: NativeSyntheticEvent<NativeScrollEvent>) => {
                const next = Math.round(event.nativeEvent.contentOffset.x / featuredWidth);
                setFeaturedIndex(Math.max(0, Math.min(featured.length - 1, next)));
              }}
            >
              {featured.map((clip) => (
                <Pressable
                  key={clip.id}
                  style={[styles.featured, { width: featuredWidth }]}
                  onPress={() => openClip(clip.slug)}
                >
                  <ClipThumb title={clip.title || "Clip"} thumbnailUrl={clip.thumbnailUrl} radius={22} />
                  <View style={styles.featuredScrim} />
                  <View style={styles.featuredBadge}>
                    <Ionicons name="star" size={12} color="#fff" />
                    <Text style={styles.featuredBadgeText}>FEATURED</Text>
                  </View>
                  <View style={styles.featuredCopy}>
                    <Text style={styles.featuredTitle} numberOfLines={2}>
                      {clip.title || "Untitled clip"}
                    </Text>
                    <Text style={styles.featuredSub} numberOfLines={1}>
                      {clip.game?.name || "Today’s most watched"}
                    </Text>
                    <View style={styles.featuredAuthor}>
                      <Avatar name={clip.author.displayName || clip.author.username} uri={clip.author.avatarUrl} size={20} />
                      <Text style={styles.featuredHandle}>{formatHandle(clip.author)}</Text>
                      {clip.author.verified ? <Ionicons name="checkmark-circle" size={14} color={colors.accent} /> : null}
                    </View>
                  </View>
                  <View style={styles.featuredPlay}>
                    <Ionicons name="play" size={22} color="#fff" />
                  </View>
                  {clip.durationMs ? <Text style={styles.duration}>{formatDurationMs(clip.durationMs)}</Text> : null}
                </Pressable>
              ))}
            </ScrollView>
            <View style={styles.dots}>
              {featured.map((clip, index) => (
                <View key={clip.id} style={[styles.dot, index === featuredIndex && styles.dotActive]} />
              ))}
            </View>
          </View>
        ) : null}

        {continueWatching.length > 0 ? (
          <Section title="Continue Watching">
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.rail}>
              {continueWatching.map((item) => (
                <Pressable key={item.slug} style={styles.continueCard} onPress={() => openClip(item.slug)}>
                  <View>
                    <ClipThumb title={item.title || "Clip"} thumbnailUrl={item.thumbnailUrl} radius={12} />
                    <View style={styles.playCenter}>
                      <Ionicons name="play" size={16} color="#fff" />
                    </View>
                    {item.durationMs ? <Text style={styles.duration}>{formatDurationMs(item.durationMs)}</Text> : null}
                  </View>
                  <Text style={styles.continueTitle} numberOfLines={1}>
                    {item.title || "Untitled clip"}
                  </Text>
                  <View style={styles.progressTrack}>
                    <View style={[styles.progressFill, { width: `${Math.round(item.progress * 100)}%` }]} />
                  </View>
                  <Text style={styles.progressLabel}>{Math.round(item.progress * 100)}% watched</Text>
                </Pressable>
              ))}
            </ScrollView>
          </Section>
        ) : null}

        <Section title="From friends">
          {!token ? (
            <Text style={styles.muted}>Add friends to see their clips here.</Text>
          ) : friendClips === null ? (
            <Text style={styles.muted}>Loading friends’ clips…</Text>
          ) : friendClips.length === 0 ? (
            <Pressable onPress={() => router.push(session ? "/friends" : "/signin")}>
              <Text style={styles.muted}>Add friends to see their clips here.</Text>
            </Pressable>
          ) : (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.rail}>
              {friendClips.map((clip) => (
                <Pressable key={clip.id} style={styles.continueCard} onPress={() => openClip(clip.slug)}>
                  <ClipThumb title={clip.title || "Clip"} thumbnailUrl={clip.thumbnailUrl} radius={12} />
                  <Text style={styles.continueTitle} numberOfLines={1}>
                    {clip.title || "Untitled clip"}
                  </Text>
                  <Text style={styles.gameCount} numberOfLines={1}>
                    {formatHandle(clip.author)}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          )}
        </Section>

        <Section title="Favorite Games">
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.rail}>
            {games.map((game) => (
              <Pressable key={game.id} style={styles.game} onPress={() => router.push(`/games/${game.slug}`)}>
                <View style={[styles.gameRing, { shadowColor: gameGlow(game.slug), borderColor: gameGlow(game.slug) }]}>
                  <GameCover name={game.name} coverUrl={game.coverUrl} round size={68} />
                </View>
                <Text style={styles.gameName} numberOfLines={1}>
                  {game.name}
                </Text>
                <Text style={styles.gameCount}>
                  {game.clipCount != null ? `${formatCount(game.clipCount)} clips` : "Public clips"}
                </Text>
              </Pressable>
            ))}
            <Pressable style={styles.game} onPress={() => router.push("/games")}>
              <View style={styles.addGame}>
                <Ionicons name="add" size={26} color={colors.muted} />
              </View>
              <Text style={styles.gameName}>Add Game</Text>
              <Text style={styles.gameCount}>Browse</Text>
            </Pressable>
          </ScrollView>
        </Section>

        <Section title="For You">
          {feed.length === 0 ? (
            <Text style={styles.muted}>When someone makes a clip public, it lands here. Unlisted links never appear.</Text>
          ) : (
            <View style={styles.feed}>
              {feed.map((clip) => (
                <View key={clip.id} style={styles.feedCard}>
                  <Pressable style={styles.feedThumb} onPress={() => openClip(clip.slug)}>
                    <ClipThumb title={clip.title || "Clip"} thumbnailUrl={clip.thumbnailUrl} radius={12} />
                    <View style={styles.playCenter}>
                      <Ionicons name="play" size={16} color="#fff" />
                    </View>
                    {clip.durationMs ? <Text style={styles.duration}>{formatDurationMs(clip.durationMs)}</Text> : null}
                  </Pressable>
                  <View style={styles.feedBody}>
                    <View style={styles.feedHead}>
                      <Avatar name={clip.author.displayName || clip.author.username} uri={clip.author.avatarUrl} size={22} />
                      <Text style={styles.handle} numberOfLines={1}>
                        {formatHandle(clip.author)}
                      </Text>
                      {clip.author.verified ? <Ionicons name="checkmark-circle" size={14} color={colors.accent} /> : null}
                      {clip.createdAt ? <Text style={styles.time}>{formatTimeAgo(clip.createdAt)}</Text> : null}
                    </View>
                    <Pressable onPress={() => openClip(clip.slug)}>
                      <Text style={styles.feedTitle} numberOfLines={2}>
                        {clip.title || "Untitled clip"}
                      </Text>
                      {clip.description ? (
                        <Text style={styles.feedCopy} numberOfLines={2}>
                          {clip.description}
                        </Text>
                      ) : null}
                    </Pressable>
                    {clip.game ? (
                      <View style={styles.tags}>
                        <Text style={styles.tag}>{clip.game.name}</Text>
                      </View>
                    ) : null}
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
                      </Pressable>
                    </View>
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
          const apply = (item: PublicClipCard) => (item.slug === commentSlug ? { ...item, commentCount: count } : item);
          setFeed((current) => current.map(apply));
          setFeatured((current) => current.map(apply));
        }}
      />
      <NotificationsSheet
        visible={notificationsOpen}
        token={token}
        onClose={() => setNotificationsOpen(false)}
      />
    </SafeAreaView>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.heading}>{title}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  page: { flex: 1, backgroundColor: colors.bg },
  content: { paddingHorizontal: 16, paddingBottom: 40, gap: 22 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingTop: 4 },
  brandLogo: { width: 148, height: 40 },
  headerActions: { flexDirection: "row", alignItems: "center", gap: 12 },
  bell: {
    position: "relative",
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.card,
    alignItems: "center",
    justifyContent: "center",
  },
  bellPip: {
    position: "absolute",
    top: 6,
    right: 6,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.accent,
  },
  houseAd: {
    backgroundColor: colors.card,
    borderRadius: 16,
    padding: 14,
    gap: 4,
  },
  houseAdTitle: { color: colors.text, fontSize: 15, fontWeight: "700" },
  houseAdCopy: { color: colors.muted, fontSize: 13 },
  featuredBlock: { gap: 10 },
  featured: { borderRadius: 22, overflow: "hidden", backgroundColor: colors.card },
  featuredScrim: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: 150,
    backgroundColor: "#00000088",
  },
  featuredBadge: {
    position: "absolute",
    top: 12,
    left: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: colors.accent,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  featuredBadgeText: { color: "#fff", fontSize: 10, fontWeight: "800", letterSpacing: 0.4 },
  featuredCopy: { position: "absolute", left: 14, right: 72, bottom: 14, gap: 4 },
  featuredTitle: { color: "#fff", fontSize: 22, fontWeight: "800" },
  featuredSub: { color: "#d7dde6", fontSize: 13 },
  featuredAuthor: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 2 },
  featuredHandle: { color: "#fff", fontWeight: "600", fontSize: 12 },
  featuredPlay: {
    position: "absolute",
    right: 16,
    top: "50%",
    marginTop: -24,
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: "#ffffff33",
    alignItems: "center",
    justifyContent: "center",
  },
  dots: { flexDirection: "row", justifyContent: "center", gap: 6 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: "#2a3544" },
  dotActive: { width: 18, backgroundColor: colors.accent },
  section: { gap: 12 },
  heading: { color: colors.text, fontSize: 20, fontWeight: "800" },
  muted: { color: colors.muted, fontSize: 14, lineHeight: 20 },
  rail: { gap: 14, paddingRight: 8 },
  continueCard: { width: 148, gap: 6 },
  continueTitle: { color: colors.text, fontWeight: "700", fontSize: 13 },
  progressTrack: { height: 3, borderRadius: 2, backgroundColor: "#243041", overflow: "hidden" },
  progressFill: { height: "100%", backgroundColor: colors.accent },
  progressLabel: { color: colors.muted, fontSize: 11 },
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
  game: { width: 86, alignItems: "center", gap: 6 },
  gameRing: {
    borderWidth: 2,
    borderRadius: 999,
    padding: 2,
    shadowOpacity: 0.45,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 0 },
  },
  gameName: { color: colors.text, fontSize: 12, fontWeight: "700", textAlign: "center" },
  gameCount: { color: colors.muted, fontSize: 11, textAlign: "center" },
  addGame: {
    width: 72,
    height: 72,
    borderRadius: 36,
    borderWidth: 2,
    borderStyle: "dashed",
    borderColor: "#3a4658",
    alignItems: "center",
    justifyContent: "center",
  },
  feed: { gap: 14 },
  feedCard: { flexDirection: "row", gap: 12, backgroundColor: colors.card, borderRadius: 16, padding: 10 },
  feedThumb: { width: 118 },
  feedBody: { flex: 1, gap: 6 },
  feedHead: { flexDirection: "row", alignItems: "center", gap: 6 },
  handle: { color: colors.text, fontSize: 12, fontWeight: "700", flexShrink: 1 },
  time: { color: colors.muted, fontSize: 11, marginLeft: "auto" },
  feedTitle: { color: colors.text, fontWeight: "800", fontSize: 15 },
  feedCopy: { color: colors.muted, fontSize: 12, lineHeight: 17 },
  tags: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  tag: {
    color: colors.accent,
    borderColor: "#2a4d86",
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
    fontSize: 11,
    fontWeight: "700",
    overflow: "hidden",
  },
  actions: { flexDirection: "row", alignItems: "center", gap: 14, marginTop: 2 },
  action: { flexDirection: "row", alignItems: "center", gap: 4 },
  actionText: { color: colors.text, fontSize: 12, fontWeight: "600" },
});
