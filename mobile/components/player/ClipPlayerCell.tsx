import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useVideoPlayer, VideoView, type VideoPlayer } from "expo-video";
import { Avatar } from "@/components/Avatar";
import { CommentsSheet } from "@/components/CommentsSheet";
import { PlayerTools } from "@/components/PlayerTools";
import { PlayerTopChrome } from "@/components/player/PlayerTopChrome";
import { PlayerVideoFrame, ReplayrWatermark } from "@/components/ReplayrWatermark";
import { SendClipSheet } from "@/components/SendClipSheet";
import { TimelineBar } from "@/components/TimelineBar";
import { clipAllowsSocial, deleteCloudClip, setClipLiked, type PlaybackClip } from "@/lib/api";
import { followUser } from "@/lib/api.follows";
import { loadPlayback, type ClipFeedItem, getClipFeed } from "@/lib/clipFeed";
import { feedPlaybackAllowed, registerFeedPlayer, unregisterFeedPlayer } from "@/lib/feedPlayers";
import { formatHandle } from "@/lib/format";
import { copyClipUrl, saveClipToPhotos, shareClipUrl } from "@/lib/media";
import { setPendingDeepLink } from "@/lib/pendingDeepLink";
import { clipShareUrl, getSupabase } from "@/lib/supabase";
import { colors } from "@/lib/theme";
import { saveWatchProgress } from "@/lib/watchProgress";
import { PlayerMoreSheet } from "./PlayerMoreSheet";

function pausePlayer(instance: VideoPlayer) {
  try {
    instance.pause();
  } catch {
    /* native player is already gone */
  }
}

export function ClipPlayerCell({
  item,
  active,
  nearby,
  height,
  token,
  userId,
  showAd,
  onDeleted,
}: {
  item: ClipFeedItem;
  active: boolean;
  nearby: boolean;
  height: number;
  token?: string;
  userId?: string;
  showAd: boolean;
  onBack?: () => void;
  onDeleted: (slug: string) => void;
}) {
  const [clip, setClip] = useState<PlaybackClip | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!nearby) return;
    let cancelled = false;
    void loadPlayback(item.slug, token)
      .then((next) => {
        if (!cancelled) {
          setClip(next);
          setError(null);
        }
      })
      .catch((caught) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Clip unavailable");
      });
    return () => {
      cancelled = true;
    };
  }, [nearby, item.slug, token]);

  return (
    <View style={{ height, backgroundColor: "#000" }}>
      {error ? (
        <View style={styles.center}>
          <Text style={styles.title}>Clip unavailable</Text>
          <Text style={styles.muted}>{error}</Text>
        </View>
      ) : clip && nearby ? (
        <ReadyCell
          clip={clip}
          clipId={item.clipId || clip.id}
          active={active}
          token={token}
          userId={userId}
          showAd={showAd}
          onDeleted={onDeleted}
        />
      ) : (
        <View style={styles.center}>
          <Text style={styles.muted}>{nearby ? "Loading…" : ""}</Text>
        </View>
      )}
    </View>
  );
}

function ReadyCell({
  clip,
  clipId,
  active,
  token,
  userId,
  showAd,
  onDeleted,
}: {
  clip: PlaybackClip;
  clipId?: string;
  active: boolean;
  token?: string;
  userId?: string;
  showAd: boolean;
  onDeleted: (slug: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const fallbackDuration = (clip.durationMs ?? 0) / 1000;
  const router = useRouter();
  const shareable = clipAllowsSocial(clip.visibility);
  const canManage = Boolean(userId && clipId);
  const feedMode = getClipFeed()?.source === "foryou" ? "foryou" : getClipFeed()?.source === "library" ? "single" : "single";
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(fallbackDuration);
  const scrubbingRef = useRef(false);
  const [liked, setLiked] = useState(Boolean(clip.liked));
  const [following, setFollowing] = useState(Boolean(clip.following));
  const [followPending, setFollowPending] = useState(Boolean(clip.followPending));
  const [followBusy, setFollowBusy] = useState(false);
  const [likeCount, setLikeCount] = useState(clip.likeCount ?? 0);
  const [commentCount, setCommentCount] = useState(clip.commentCount ?? 0);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [morePanel, setMorePanel] = useState<"menu" | "visibility" | "delete">("menu");
  const player = useVideoPlayer(clip.playbackUrl, (instance) => {
    instance.loop = true;
    instance.timeUpdateEventInterval = 0.25;
    if (active && feedPlaybackAllowed()) instance.play();
  });
  const playerRef = useRef(player);
  playerRef.current = player;

  useEffect(() => {
    registerFeedPlayer(player);
    return () => {
      unregisterFeedPlayer(player);
    };
  }, [player]);

  useEffect(() => {
    try {
      if (active && !sendOpen && feedPlaybackAllowed()) player.play();
      else pausePlayer(player);
    } catch {
      /* native player is already gone */
    }
  }, [active, sendOpen, player]);

  useEffect(() => {
    let lastSaved = 0;
    let latestTime = 0;
    let latestDuration = fallbackDuration;
    const persist = (seconds: number, length: number) => {
      const total = length > 0 ? length : fallbackDuration;
      if (total <= 0) return;
      void saveWatchProgress({
        slug: clip.slug,
        title: clip.title,
        thumbnailUrl: clip.thumbnailUrl ?? null,
        durationMs: Math.round(total * 1000),
        progress: Math.min(1, Math.max(0, seconds / total)),
        updatedAt: Date.now(),
      });
    };
    const sub = player.addListener("timeUpdate", (event) => {
      latestTime = event.currentTime;
      if (!scrubbingRef.current) {
        setCurrent(event.currentTime);
      }
      try {
        if (player.duration > 0) {
          latestDuration = player.duration;
          setDuration(player.duration);
        }
      } catch {
        /* native player already released */
      }
      if (event.currentTime - lastSaved >= 5) {
        lastSaved = event.currentTime;
        persist(event.currentTime, latestDuration);
      }
    });
    return () => {
      persist(latestTime, latestDuration);
      sub.remove();
    };
  }, [player, clip.slug, clip.title, clip.thumbnailUrl, fallbackDuration]);

  useFocusEffect(
    useCallback(() => {
      return () => {
        unregisterFeedPlayer(playerRef.current);
      };
    }, []),
  );

  function togglePlayback() {
    if (moreOpen) {
      setMoreOpen(false);
      setMorePanel("menu");
      return;
    }
    try {
      if (player.playing || !feedPlaybackAllowed()) pausePlayer(player);
      else player.play();
    } catch {
      /* native player is already gone */
    }
  }

  async function setVisibility(visibility: "public" | "unlisted" | "private") {
    if (!userId || !clipId) return;
    await getSupabase().from("clips").update({ visibility }).eq("id", clipId).eq("user_id", userId);
    setMoreOpen(false);
    setMorePanel("menu");
  }

  function requireSocial() {
    if (!shareable) {
      Alert.alert("Private clip", "Make this clip unlisted or public to like and comment.");
      return false;
    }
    return true;
  }

  async function goSignIn() {
    await setPendingDeepLink(`/c/${clip.slug}`);
    router.push("/signin");
  }

  async function onFollow() {
    const username = clip.author?.username;
    if (!username || clip.mine || following || followPending || followBusy) return;
    if (!token) {
      await goSignIn();
      return;
    }
    setFollowBusy(true);
    const optimistic = { following: !clip.author?.isPrivate, followPending: Boolean(clip.author?.isPrivate) };
    setFollowing(optimistic.following);
    setFollowPending(optimistic.followPending);
    try {
      const result = await followUser(token, username);
      setFollowing(result.follow.viewerFollows);
      setFollowPending(result.follow.viewerFollowPending);
    } catch {
      setFollowing(false);
      setFollowPending(false);
    } finally {
      setFollowBusy(false);
    }
  }

  const handle = formatHandle(clip.author);
  const showFollow = Boolean(clip.author?.username) && !clip.mine && !following && !followPending;
  const visibilityLabel =
    clip.visibility === "public" ? "Public" : clip.visibility === "unlisted" ? "Unlisted" : "Private";

  return (
    <View style={styles.stage}>
      <PlayerVideoFrame width={clip.width} height={clip.height}>
        <VideoView player={player} style={styles.video} nativeControls={false} contentFit="contain" pointerEvents="none" />
        <ReplayrWatermark show={clip.watermark !== false} />
      </PlayerVideoFrame>
      <Pressable style={styles.tap} onPress={togglePlayback} />
      {active ? <PlayerTopChrome top={insets.top} mode={feedMode} /> : null}
      {showAd ? (
        <Pressable style={[styles.houseAd, { top: insets.top + 56 }]} onPress={() => router.push("/account")}>
          <Text style={styles.houseAdTitle}>Replayr Premium — $4.99/mo</Text>
          <Text style={styles.houseAdCopy}>Remove the watermark · original quality</Text>
        </Pressable>
      ) : null}
      <View style={styles.hud} pointerEvents="box-none">
        <View style={[styles.meta, { bottom: 54 }]} pointerEvents="box-none">
          <View style={styles.authorRow} pointerEvents="box-none">
            <Pressable
              style={styles.authorPress}
              onPress={() => {
                if (clip.author?.username) router.push(`/u/${clip.author.username}`);
              }}
              disabled={!clip.author?.username}
            >
              <Avatar name={clip.author?.displayName || clip.author?.username} uri={clip.author?.avatarUrl} size={40} />
              <View style={styles.authorText}>
                <View style={styles.handleRow}>
                  <Text style={styles.handle}>{handle}</Text>
                  {clip.author?.verified ? <Text style={styles.verified}>✓</Text> : null}
                </View>
              </View>
            </Pressable>
            {showFollow ? (
              <Pressable style={styles.followBtn} onPress={() => void onFollow()} disabled={followBusy}>
                <Text style={styles.followLabel}>Follow</Text>
              </Pressable>
            ) : null}
          </View>
          <Text style={styles.title} numberOfLines={2}>
            {clip.title || "Untitled clip"}
          </Text>
          <View style={styles.tags}>
            <Text style={styles.tag}>{visibilityLabel}</Text>
          </View>
        </View>
        <TimelineBar
          current={current}
          duration={duration}
          bottom={8}
          onSeekStart={() => {
            scrubbingRef.current = true;
          }}
          onSeek={(seconds) => {
            try {
              player.currentTime = seconds;
            } catch {
              /* native player already released */
            }
            setCurrent(seconds);
          }}
          onSeekEnd={(seconds) => {
            try {
              player.currentTime = seconds;
            } catch {
              /* native player already released */
            }
            setCurrent(seconds);
            scrubbingRef.current = false;
          }}
        />
        <PlayerTools
          liked={liked}
          likeCount={likeCount}
          commentCount={commentCount}
          bottom={72}
          onLike={() => {
            if (!token) {
              void goSignIn();
              return;
            }
            if (!requireSocial()) return;
            const next = !liked;
            setLiked(next);
            setLikeCount((count) => Math.max(0, count + (next ? 1 : -1)));
            void setClipLiked(clip.slug, next, token)
              .then((result) => {
                setLiked(result.liked);
                setLikeCount(result.likeCount);
              })
              .catch(() => {
                setLiked(!next);
                setLikeCount((count) => Math.max(0, count + (next ? -1 : 1)));
              });
          }}
          onComment={() => {
            if (!requireSocial()) return;
            setCommentsOpen(true);
          }}
          onCopy={() => {
            void copyClipUrl(clipShareUrl(clip.slug));
          }}
          onSend={() => {
            if (!token) {
              void goSignIn();
              return;
            }
            pausePlayer(player);
            setSendOpen(true);
          }}
          onMore={() => {
            setMorePanel("menu");
            setMoreOpen(true);
          }}
        />
      </View>
      {moreOpen ? (
        <PlayerMoreSheet
          title={clip.title || "Clip"}
          canManage={canManage}
          panel={morePanel}
          onPanel={setMorePanel}
          onShare={() => {
            void shareClipUrl(clipShareUrl(clip.slug));
            setMoreOpen(false);
          }}
          onSave={() => {
            void saveClipToPhotos(clip.slug, clip.title, token).catch((caught) => {
              Alert.alert("Could not save", caught instanceof Error ? caught.message : "Try again.");
            });
            setMoreOpen(false);
          }}
          onVisibility={(visibility) => void setVisibility(visibility)}
          onDelete={() => {
            if (!token || !clipId) return;
            pausePlayer(player);
            void deleteCloudClip(clipId, token)
              .then(() => onDeleted(clip.slug))
              .catch((caught) => {
                Alert.alert("Could not delete", caught instanceof Error ? caught.message : "Try again.");
              });
          }}
          onClose={() => {
            setMoreOpen(false);
            setMorePanel("menu");
          }}
        />
      ) : null}
      <CommentsSheet
        slug={clip.slug}
        visible={commentsOpen}
        token={token}
        onClose={() => setCommentsOpen(false)}
        onCount={setCommentCount}
      />
      <SendClipSheet slug={clip.slug} visible={sendOpen} onClose={() => setSendOpen(false)} />
    </View>
  );
}

const styles = StyleSheet.create({
  stage: { flex: 1, backgroundColor: "#000" },
  video: { width: "100%", height: "100%", backgroundColor: "#000" },
  tap: { ...StyleSheet.absoluteFill },
  hud: { ...StyleSheet.absoluteFill, zIndex: 2, elevation: 2 },
  meta: { position: "absolute", left: 14, right: 78, gap: 8 },
  authorRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  authorPress: { flexDirection: "row", alignItems: "center", gap: 10, flexShrink: 1 },
  authorText: { flexShrink: 1 },
  handleRow: { flexDirection: "row", alignItems: "center", gap: 4 },
  handle: { color: "#fff", fontSize: 15, fontWeight: "800" },
  verified: { color: colors.accent, fontSize: 13, fontWeight: "900" },
  followBtn: {
    borderWidth: 1.5,
    borderColor: colors.accent,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
  followLabel: { color: colors.accent, fontSize: 13, fontWeight: "800" },
  title: { color: "#fff", fontSize: 16, fontWeight: "700" },
  tags: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  tag: { color: "rgba(255,255,255,0.72)", fontSize: 12, fontWeight: "600" },
  muted: { color: "#c8c8c8", fontSize: 13 },
  center: { flex: 1, backgroundColor: "#000", padding: 24, justifyContent: "center", gap: 8 },
  // title reused for unavailable state heading via styles.title
  houseAd: {
    position: "absolute",
    left: 16,
    right: 80,
    top: 64,
    backgroundColor: "rgba(12,14,20,0.82)",
    borderRadius: 10,
    padding: 10,
    zIndex: 3,
    gap: 2,
  },
  houseAdTitle: { color: "#fff", fontSize: 13, fontWeight: "700" },
  houseAdCopy: { color: "#c8c8c8", fontSize: 12 },
});
