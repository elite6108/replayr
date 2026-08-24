import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useVideoPlayer, VideoView, type VideoPlayer } from "expo-video";
import { PlayerTools } from "@/components/PlayerTools";
import { TimelineBar } from "@/components/TimelineBar";
import { CommentsSheet } from "@/components/CommentsSheet";
import { SendClipSheet } from "@/components/SendClipSheet";
import { clipAllowsSocial, deleteCloudClip, fetchPlayback, setClipLiked, type PlaybackClip } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatHandle } from "@/lib/format";
import { copyClipUrl, saveClipToPhotos, shareClipUrl } from "@/lib/media";
import { clipShareUrl, getSupabase } from "@/lib/supabase";
import { saveWatchProgress } from "@/lib/watchProgress";

function firstParam(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

function pausePlayer(instance: VideoPlayer) {
  try {
    instance.pause();
  } catch {
    /* native player is already gone */
  }
}

export default function ClipScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ slug?: string | string[]; clipId?: string | string[] }>();
  const slug = firstParam(params.slug);
  const clipId = firstParam(params.clipId) || undefined;
  const { session } = useAuth();
  const [clip, setClip] = useState<PlaybackClip | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setClip(null);
    setLoadError(null);
    void fetchPlayback(slug, session?.access_token)
      .then((next) => {
        if (!cancelled) setClip(next);
      })
      .catch((caught) => {
        if (!cancelled) setLoadError(caught instanceof Error ? caught.message : "Clip unavailable");
      });
    return () => {
      cancelled = true;
    };
  }, [slug, session?.access_token]);

  if (loadError) {
    return (
      <View style={styles.center}>
        <Text style={styles.title}>Clip unavailable</Text>
        <Text style={styles.muted}>{loadError}</Text>
      </View>
    );
  }

  if (!clip) {
    return (
      <View style={styles.center}>
        <Text style={styles.muted}>Loading…</Text>
      </View>
    );
  }

  return (
    <ReadyPlayer
      key={clip.playbackUrl}
      clip={clip}
      clipId={clipId || clip.id}
      token={session?.access_token}
      userId={session?.user.id}
      onBack={() => router.back()}
    />
  );
}

function ReadyPlayer({
  clip,
  clipId,
  token,
  userId,
  onBack,
}: {
  clip: PlaybackClip;
  clipId?: string;
  token?: string;
  userId?: string;
  onBack: () => void;
}) {
  const insets = useSafeAreaInsets();
  const fallbackDuration = (clip.durationMs ?? 0) / 1000;
  const router = useRouter();
  const shareable = clipAllowsSocial(clip.visibility);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(fallbackDuration);
  const [liked, setLiked] = useState(Boolean(clip.liked));
  const [likeCount, setLikeCount] = useState(clip.likeCount ?? 0);
  const [commentCount, setCommentCount] = useState(clip.commentCount ?? 0);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  const player = useVideoPlayer(clip.playbackUrl, (instance) => {
    instance.loop = true;
    instance.timeUpdateEventInterval = 0.25;
    instance.play();
  });
  const playerRef = useRef(player);
  playerRef.current = player;

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
      setCurrent(event.currentTime);
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
        pausePlayer(playerRef.current);
      };
    }, []),
  );

  useEffect(() => {
    if (commentsOpen || sendOpen) pausePlayer(player);
  }, [commentsOpen, sendOpen, player]);

  function togglePlayback() {
    try {
      if (player.playing) pausePlayer(player);
      else player.play();
    } catch {
      /* native player is already gone */
    }
  }

  function more() {
    Alert.alert(clip.title || "Clip", undefined, [
      { text: "Share", onPress: () => void shareClipUrl(clipShareUrl(clip.slug)) },
      {
        text: "Save to Photos",
        onPress: () => {
          void saveClipToPhotos(clip.slug, clip.title, token).catch((caught) => {
            Alert.alert("Could not save", caught instanceof Error ? caught.message : "Try again.");
          });
        },
      },
      ...(userId && clipId
        ? [
            {
              text: "Visibility",
              onPress: () => {
                Alert.alert("Visibility", "Unlisted links never include your username.", [
                  { text: "Unlisted", onPress: () => void setVisibility("unlisted") },
                  { text: "Private", onPress: () => void setVisibility("private") },
                  { text: "Public", onPress: () => void setVisibility("public") },
                  { text: "Cancel", style: "cancel" as const },
                ]);
              },
            },
            {
              text: "Delete",
              style: "destructive" as const,
              onPress: () => {
                if (!token || !clipId) return;
                Alert.alert("Delete this clip?", "Removes the cloud copy.", [
                  { text: "Cancel", style: "cancel" },
                  {
                    text: "Delete",
                    style: "destructive",
                    onPress: () => {
                      pausePlayer(player);
                      void deleteCloudClip(clipId, token).then(onBack);
                    },
                  },
                ]);
              },
            },
          ]
        : []),
      { text: "Cancel", style: "cancel" },
    ]);
  }

  async function setVisibility(visibility: "public" | "unlisted" | "private") {
    if (!userId || !clipId) return;
    await getSupabase().from("clips").update({ visibility }).eq("id", clipId).eq("user_id", userId);
  }

  function requireSocial() {
    if (!shareable) {
      Alert.alert("Private clip", "Make this clip unlisted or public to like and comment.");
      return false;
    }
    return true;
  }

  return (
    <View style={styles.stage}>
      <VideoView
        player={player}
        style={[styles.video, commentsOpen && styles.videoHidden]}
        nativeControls={false}
        contentFit="contain"
        pointerEvents="none"
      />
      <Pressable style={styles.tap} onPress={togglePlayback} />
      <View style={styles.hud} pointerEvents="box-none">
        <Pressable
          style={[styles.back, { top: insets.top + 8 }]}
          onPress={() => {
            pausePlayer(player);
            onBack();
          }}
          hitSlop={12}
        >
          <Ionicons name="chevron-back" size={28} color="#fff" />
        </Pressable>
        <View style={[styles.caption, { bottom: insets.bottom + 36 }]} pointerEvents="none">
          <Text style={styles.title}>{clip.title || "Untitled clip"}</Text>
          <Text style={styles.muted}>
            {clip.visibility === "public" ? formatHandle(clip.author) : clip.visibility}
          </Text>
        </View>
        <TimelineBar
          current={current}
          duration={duration}
          bottom={insets.bottom + 8}
          onSeek={(seconds) => {
            player.currentTime = seconds;
            setCurrent(seconds);
          }}
        />
        <PlayerTools
          liked={liked}
          likeCount={likeCount}
          commentCount={commentCount}
          bottom={insets.bottom + 88}
          onLike={() => {
            if (!token) {
              router.push("/signin");
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
            pausePlayer(player);
            setCommentsOpen(true);
          }}
          onCopy={() => {
            void copyClipUrl(clipShareUrl(clip.slug));
          }}
          onSend={() => {
            if (!token) {
              router.push("/signin");
              return;
            }
            pausePlayer(player);
            setSendOpen(true);
          }}
          onMore={more}
        />
      </View>
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
  video: { flex: 1, backgroundColor: "#000" },
  videoHidden: { opacity: 0 },
  tap: { ...StyleSheet.absoluteFill },
  hud: { ...StyleSheet.absoluteFill, zIndex: 2, elevation: 2 },
  back: { position: "absolute", top: 52, left: 12, padding: 8, zIndex: 3 },
  caption: { position: "absolute", left: 16, right: 80, bottom: 28, gap: 4 },
  title: { color: "#fff", fontSize: 18, fontWeight: "700" },
  muted: { color: "#c8c8c8", fontSize: 13, textTransform: "capitalize" },
  center: { flex: 1, backgroundColor: "#000", padding: 24, justifyContent: "center", gap: 8 },
});
