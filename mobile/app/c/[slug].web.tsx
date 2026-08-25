import { createElement, useEffect, useRef, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { CommentsSheet } from "@/components/CommentsSheet";
import { PlayerTools } from "@/components/PlayerTools";
import { PlayerVideoFrame, ReplayrWatermark } from "@/components/ReplayrWatermark";
import { SendClipSheet } from "@/components/SendClipSheet";
import { TimelineBar } from "@/components/TimelineBar";
import { clipAllowsSocial, fetchBillingStatus, fetchPlayback, setClipLiked, type PlaybackClip } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatHandle } from "@/lib/format";
import { copyClipUrl, shareClipUrl } from "@/lib/media";
import { clipShareUrl } from "@/lib/supabase";

export default function ClipScreen() {
  const router = useRouter();
  const { slug = "" } = useLocalSearchParams<{ slug: string }>();
  const { session } = useAuth();
  const [clip, setClip] = useState<PlaybackClip | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [liked, setLiked] = useState(false);
  const [likeCount, setLikeCount] = useState(0);
  const [commentCount, setCommentCount] = useState(0);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [watermark, setWatermark] = useState(true);
  const [showAd, setShowAd] = useState(true);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    return () => {
      videoRef.current?.pause();
    };
  }, []);

  useEffect(() => {
    if (commentsOpen || sendOpen) videoRef.current?.pause();
  }, [commentsOpen, sendOpen]);

  useEffect(() => {
    let cancelled = false;
    void fetchPlayback(slug, session?.access_token)
      .then((next) => {
        if (!cancelled) {
          setClip(next);
          setLiked(Boolean(next.liked));
          setLikeCount(next.likeCount ?? 0);
          setCommentCount(next.commentCount ?? 0);
        }
      })
      .catch((caught) => {
        if (!cancelled) setLoadError(caught instanceof Error ? caught.message : "Clip unavailable");
      });
    if (session?.access_token) {
      void fetchBillingStatus(session.access_token)
        .then((status) => {
          if (!cancelled) {
            setWatermark(status.watermark);
            setShowAd(status.ads);
          }
        })
        .catch(() => undefined);
    } else {
      setWatermark(true);
      setShowAd(true);
    }
    return () => {
      cancelled = true;
    };
  }, [slug, session?.access_token]);

  if (loadError || !clip) {
    return (
      <View style={styles.center}>
        <Text style={styles.title}>{loadError ? "Clip unavailable" : "Loading…"}</Text>
        {loadError ? <Text style={styles.muted}>{loadError}</Text> : null}
      </View>
    );
  }

  return (
    <View style={styles.stage}>
      <PlayerVideoFrame width={clip.width} height={clip.height}>
        {createElement("video", {
          key: clip.playbackUrl,
          ref: (node: HTMLVideoElement | null) => {
            videoRef.current = node;
          },
          src: clip.playbackUrl,
          poster: clip.thumbnailUrl || undefined,
          autoPlay: true,
          loop: true,
          playsInline: true,
          onTimeUpdate: (event: { currentTarget: HTMLVideoElement }) => {
            setCurrent(event.currentTarget.currentTime);
            if (event.currentTarget.duration) setDuration(event.currentTarget.duration);
          },
          style: { width: "100%", height: "100%", backgroundColor: "#000", objectFit: "contain" },
        })}
        <ReplayrWatermark show={watermark} />
      </PlayerVideoFrame>
      {showAd ? (
        <Pressable style={styles.houseAd} onPress={() => router.push("/account")}>
          <Text style={styles.houseAdTitle}>Replayr Premium — $4.99/mo</Text>
          <Text style={styles.houseAdCopy}>Remove the watermark · original quality</Text>
        </Pressable>
      ) : null}
      <Pressable
        style={styles.back}
        onPress={() => {
          videoRef.current?.pause();
          router.back();
        }}
      >
        <Ionicons name="chevron-back" size={28} color="#fff" />
      </Pressable>
      <View style={[styles.caption, { bottom: 48 }]} pointerEvents="none">
        <Text style={styles.title}>{clip.title || "Untitled clip"}</Text>
        <Text style={styles.muted}>{clip.visibility === "public" ? formatHandle(clip.author) : clip.visibility}</Text>
      </View>
      <TimelineBar
        current={current}
        duration={duration || (clip.durationMs ?? 0) / 1000}
        bottom={12}
        onSeek={(seconds) => {
          if (videoRef.current) videoRef.current.currentTime = seconds;
          setCurrent(seconds);
        }}
      />
      <PlayerTools
        liked={liked}
        likeCount={likeCount}
        commentCount={commentCount}
        bottom={96}
        onLike={() => {
          if (!session?.access_token) {
            router.push("/signin");
            return;
          }
          if (!clipAllowsSocial(clip.visibility)) return;
          const next = !liked;
          setLiked(next);
          setLikeCount((count) => Math.max(0, count + (next ? 1 : -1)));
          void setClipLiked(clip.slug, next, session.access_token)
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
          if (!clipAllowsSocial(clip.visibility)) return;
          videoRef.current?.pause();
          setCommentsOpen(true);
        }}
        onCopy={() => void copyClipUrl(clipShareUrl(clip.slug))}
        onSend={() => {
          if (!session?.access_token) {
            router.push("/signin");
            return;
          }
          videoRef.current?.pause();
          setSendOpen(true);
        }}
        onMore={() => void shareClipUrl(clipShareUrl(clip.slug)).catch(() => Alert.alert(clipShareUrl(clip.slug)))}
      />
      <CommentsSheet
        slug={clip.slug}
        visible={commentsOpen}
        token={session?.access_token}
        onClose={() => setCommentsOpen(false)}
        onCount={setCommentCount}
      />
      <SendClipSheet slug={clip.slug} visible={sendOpen} onClose={() => setSendOpen(false)} />
    </View>
  );
}

const styles = StyleSheet.create({
  stage: { flex: 1, backgroundColor: "#000" },
  back: { position: "absolute", top: 24, left: 12, padding: 8 },
  caption: { position: "absolute", left: 16, right: 80, bottom: 28, gap: 4 },
  title: { color: "#fff", fontSize: 18, fontWeight: "700" },
  muted: { color: "#c8c8c8", fontSize: 13, textTransform: "capitalize" },
  center: { flex: 1, backgroundColor: "#000", padding: 24, justifyContent: "center", gap: 8 },
  houseAd: {
    position: "absolute",
    left: 16,
    right: 80,
    top: 64,
    backgroundColor: "rgba(12,14,20,0.82)",
    borderRadius: 10,
    padding: 10,
    gap: 2,
  },
  houseAdTitle: { color: "#fff", fontSize: 13, fontWeight: "700" },
  houseAdCopy: { color: "#c8c8c8", fontSize: 12 },
});
