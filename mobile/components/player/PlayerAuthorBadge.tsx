import { useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { Avatar } from "@/components/Avatar";
import { followUser } from "@/lib/api.follows";
import type { ClipAuthor } from "@/lib/api";

export function PlayerAuthorBadge({
  author,
  following,
  followPending,
  isOwn,
  token,
  onFollowed,
}: {
  author?: ClipAuthor | null;
  following: boolean;
  followPending: boolean;
  isOwn: boolean;
  token?: string;
  onFollowed?: (next: { following: boolean; followPending: boolean }) => void;
}) {
  const router = useRouter();
  const username = author?.username ?? null;
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const showPlus = Boolean(username) && !isOwn && !following && !followPending;

  if (!author && !username) return null;

  async function onFollow() {
    if (!username || inFlight.current) return;
    if (!token) {
      router.push("/signin");
      return;
    }
    inFlight.current = true;
    setBusy(true);
    const optimistic = { following: !author?.isPrivate, followPending: Boolean(author?.isPrivate) };
    onFollowed?.(optimistic);
    try {
      const result = await followUser(token, username);
      onFollowed?.({
        following: result.follow.viewerFollows,
        followPending: result.follow.viewerFollowPending,
      });
    } catch {
      onFollowed?.({ following: false, followPending: false });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <View style={styles.wrap}>
      <Pressable
        onPress={() => {
          if (username) router.push(`/u/${username}`);
        }}
        disabled={!username}
        accessibilityRole="link"
        accessibilityLabel={username ? `Open @${username}` : "Profile"}
        hitSlop={8}
      >
        <Avatar name={author?.displayName || username} uri={author?.avatarUrl} size={48} />
      </Pressable>
      {showPlus ? (
        <Pressable
          style={[styles.plus, busy && styles.plusBusy]}
          onPress={() => void onFollow()}
          disabled={busy}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel={author?.isPrivate ? "Request to follow" : "Follow"}
        >
          <Text style={styles.plusText}>+</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: "center",
    marginBottom: 10,
  },
  plus: {
    position: "absolute",
    bottom: -6,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: "#ff2d55",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: "#000",
  },
  plusBusy: { opacity: 0.6 },
  plusText: { color: "#fff", fontSize: 16, fontWeight: "800", marginTop: -1 },
});
