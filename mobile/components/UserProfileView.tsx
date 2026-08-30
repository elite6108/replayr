import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { Avatar } from "@/components/Avatar";
import { ClipThumb } from "@/components/ClipThumb";
import { Button, Notice } from "@/components/ui";
import {
  acceptFriendRequest,
  cancelFriendRequest,
  createProfilePost,
  declineFriendRequest,
  deleteProfilePost,
  fetchFriendRequests,
  fetchUserProfile,
  sendFriendRequest,
  socialHandle,
  socialName,
  type FriendRequest,
  type UserProfileResponse,
} from "@/lib/api.friends";
import { createConversation, threadHref } from "@/lib/api.messages";
import { useAuth } from "@/lib/auth";
import { formatCount, formatDurationMs } from "@/lib/format";
import { colors } from "@/lib/theme";

export function UserProfileView({
  username,
  hideOwnActions,
}: {
  username: string;
  hideOwnActions?: boolean;
}) {
  const router = useRouter();
  const { session } = useAuth();
  const token = session?.access_token;
  const myId = session?.user.id;
  const [profile, setProfile] = useState<UserProfileResponse | null>(null);
  const [incoming, setIncoming] = useState<FriendRequest[]>([]);
  const [outgoing, setOutgoing] = useState<FriendRequest[]>([]);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"clips" | "posts">("clips");
  const [draft, setDraft] = useState("");
  const [attachId, setAttachId] = useState("");

  const load = useCallback(async () => {
    const next = await fetchUserProfile(username, token);
    setProfile(next);
    setMissing(false);
    if (token && next.relationship !== "none" && next.user.id !== myId) {
      const requests = await fetchFriendRequests(token);
      setIncoming(requests.incoming);
      setOutgoing(requests.outgoing);
    } else {
      setIncoming([]);
      setOutgoing([]);
    }
  }, [username, token, myId]);

  useEffect(() => {
    let cancelled = false;
    setProfile(null);
    setMissing(false);
    setError(null);
    void load().catch((caught) => {
      if (cancelled) return;
      const message = caught instanceof Error ? caught.message : "That account was not found.";
      if (/not found/i.test(message)) {
        setMissing(true);
        setError(null);
      } else {
        setError(message);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  const mine = Boolean(profile && myId && profile.user.id === myId);
  const name = profile ? socialName(profile.user) : username;
  const incomingRequest = incoming.find((item) => item.from.id === profile?.user.id);
  const outgoingRequest = outgoing.find((item) => item.to.id === profile?.user.id);

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await work();
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That action failed.");
    } finally {
      setBusy(false);
    }
  }

  async function openDm() {
    if (!token || !profile) return;
    setBusy(true);
    setError(null);
    try {
      const conversation = await createConversation(token, { type: "dm", userId: profile.user.id });
      router.push(threadHref(conversation.id));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not open that chat.");
    } finally {
      setBusy(false);
    }
  }

  if (missing) {
    return (
      <View style={styles.page}>
        <View style={styles.center}>
          <Text style={styles.title}>Profile unavailable</Text>
          <Text style={styles.muted}>That account was not found.</Text>
        </View>
      </View>
    );
  }

  if (error && !profile) {
    return (
      <View style={styles.page}>
        <View style={styles.center}>
          <Text style={styles.title}>Profile</Text>
          <Notice tone="danger">{error}</Notice>
        </View>
      </View>
    );
  }

  if (!profile) {
    return (
      <View style={styles.page}>
        <View style={styles.center}>
          <ActivityIndicator color={colors.accent} />
        </View>
      </View>
    );
  }

  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.content}>
      <View style={styles.hero}>
        <Avatar name={name} uri={profile.user.avatarUrl} size={72} />
        <View style={styles.heroCopy}>
          <Text style={styles.handle}>{socialHandle(profile.user) || "Player"}</Text>
          <View style={styles.nameRow}>
            <Text style={styles.title}>{name}</Text>
            {profile.user.verified ? (
              <View style={styles.verified}>
                <Text style={styles.verifiedText}>Verified</Text>
              </View>
            ) : null}
          </View>
          {profile.isPrivate ? (
            <View style={styles.verified}>
              <Text style={styles.verifiedText}>Private</Text>
            </View>
          ) : null}
          {profile.locked ? (
            <Text style={styles.bio}>This account is private.</Text>
          ) : (
            <>
              {profile.user.bio ? <Text style={styles.bio}>{profile.user.bio}</Text> : null}
              <Text style={styles.muted}>
                {formatCount(profile.user.clipCount)} public clips{mine ? " · This is you" : ""}
              </Text>
            </>
          )}
        </View>
      </View>
      <Notice tone="danger">{error}</Notice>
      {hideOwnActions && mine ? null : (
        <View style={styles.actions}>
          {mine ? (
            <Button label="Settings" onPress={() => router.push("/settings")} />
          ) : !token ? (
            <Button label="Sign in to add friends" kind="primary" onPress={() => router.push("/signin")} />
          ) : profile.relationship === "friends" ? (
            <Button label="Message" kind="primary" disabled={busy} onPress={() => void openDm()} />
          ) : profile.relationship === "outgoing" && outgoingRequest ? (
            <Button
              label="Cancel request"
              disabled={busy}
              onPress={() => void run(() => cancelFriendRequest(token, outgoingRequest.id))}
            />
          ) : profile.relationship === "outgoing" ? (
            <Text style={styles.muted}>Request sent</Text>
          ) : profile.relationship === "incoming" && incomingRequest ? (
            <>
              <Button
                label="Accept"
                kind="primary"
                disabled={busy}
                onPress={() =>
                  void run(async () => {
                    await acceptFriendRequest(token, incomingRequest.id);
                  })
                }
              />
              <Button
                label="Decline"
                disabled={busy}
                onPress={() => void run(() => declineFriendRequest(token, incomingRequest.id))}
              />
            </>
          ) : (
            <Button
              label="Add friend"
              kind="primary"
              disabled={busy}
              onPress={() =>
                void run(async () => {
                  await sendFriendRequest(token, { userId: profile.user.id });
                })
              }
            />
          )}
        </View>
      )}

      {profile.locked ? null : (
        <>
          <View style={styles.tabs}>
            <Pressable style={[styles.tab, tab === "clips" && styles.tabOn]} onPress={() => setTab("clips")}>
              <Text style={[styles.tabLabel, tab === "clips" && styles.tabLabelOn]}>Clips</Text>
            </Pressable>
            <Pressable style={[styles.tab, tab === "posts" && styles.tabOn]} onPress={() => setTab("posts")}>
              <Text style={[styles.tabLabel, tab === "posts" && styles.tabLabelOn]}>Posts</Text>
            </Pressable>
          </View>
          {tab === "clips" ? (
            profile.clips.length === 0 ? (
              <View style={styles.empty}>
                <Text style={styles.emptyTitle}>No public clips yet</Text>
                <Text style={styles.muted}>Only public uploads show here. Unlisted links stay off this profile.</Text>
              </View>
            ) : (
              <View style={styles.grid}>
                {profile.clips.map((clip) => (
                  <Pressable key={clip.id} style={styles.clip} onPress={() => router.push(`/c/${clip.slug}`)}>
                    <View style={styles.thumbWrap}>
                      <ClipThumb title={clip.title || "Clip"} thumbnailUrl={clip.thumbnailUrl} radius={12} />
                      {clip.durationMs ? <Text style={styles.duration}>{formatDurationMs(clip.durationMs)}</Text> : null}
                    </View>
                    <Text style={styles.clipTitle} numberOfLines={2}>
                      {clip.title || "Untitled clip"}
                    </Text>
                    <Text style={styles.muted}>
                      {formatCount(clip.likeCount)} likes · {formatCount(clip.commentCount)} comments
                    </Text>
                  </Pressable>
                ))}
              </View>
            )
          ) : (
            <>
              {mine && token ? (
                <View style={styles.empty}>
                  <TextInput
                    style={styles.compose}
                    value={draft}
                    onChangeText={setDraft}
                    placeholder="Write a post"
                    placeholderTextColor={colors.muted}
                    maxLength={500}
                    multiline
                  />
                  {profile.clips.length > 0 ? (
                    <View style={styles.attachList}>
                      <Pressable style={[styles.attach, !attachId && styles.attachOn]} onPress={() => setAttachId("")}>
                        <Text style={styles.muted}>No clip</Text>
                      </Pressable>
                      {profile.clips.map((clip) => (
                        <Pressable
                          key={clip.id}
                          style={[styles.attach, attachId === clip.id && styles.attachOn]}
                          onPress={() => setAttachId(clip.id)}
                        >
                          <Text style={styles.muted} numberOfLines={1}>
                            {clip.title || "Untitled clip"}
                          </Text>
                        </Pressable>
                      ))}
                    </View>
                  ) : null}
                  <Button
                    label="Post"
                    kind="primary"
                    disabled={!draft.trim() || busy}
                    onPress={() =>
                      void run(async () => {
                        await createProfilePost(token, draft.trim(), attachId || undefined);
                        setDraft("");
                        setAttachId("");
                      })
                    }
                  />
                </View>
              ) : null}
              {profile.posts.length === 0 ? (
                <View style={styles.empty}>
                  <Text style={styles.emptyTitle}>No posts yet</Text>
                </View>
              ) : (
                <View style={styles.grid}>
                  {profile.posts.map((post) => (
                    <View key={post.id} style={styles.clip}>
                      <Text style={styles.clipTitle}>{post.body}</Text>
                      <Text style={styles.muted}>{new Date(post.createdAt).toLocaleString()}</Text>
                      {mine && token ? (
                        <Button
                          label="Delete"
                          disabled={busy}
                          onPress={() => void run(() => deleteProfilePost(token, post.id))}
                        />
                      ) : null}
                      {post.clip ? (
                        <Pressable onPress={() => router.push(`/c/${post.clip!.slug}`)}>
                          <View style={styles.thumbWrap}>
                            <ClipThumb title={post.clip.title || "Clip"} thumbnailUrl={post.clip.thumbnailUrl} radius={12} />
                          </View>
                          <Text style={styles.clipTitle} numberOfLines={2}>
                            {post.clip.title || "Untitled clip"}
                          </Text>
                        </Pressable>
                      ) : null}
                    </View>
                  ))}
                </View>
              )}
            </>
          )}
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, paddingBottom: 40, gap: 14 },
  center: { flex: 1, padding: 16, gap: 12, justifyContent: "center" },
  hero: { flexDirection: "row", gap: 14, alignItems: "flex-start" },
  heroCopy: { flex: 1, gap: 4 },
  handle: { color: colors.muted, fontSize: 13, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.6 },
  nameRow: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  title: { color: colors.text, fontSize: 26, fontWeight: "800" },
  verified: {
    backgroundColor: "rgba(127, 208, 239, 0.14)",
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  verifiedText: { color: colors.accent, fontSize: 11, fontWeight: "700" },
  bio: { color: colors.text, fontSize: 15, lineHeight: 21 },
  muted: { color: colors.muted, fontSize: 14, lineHeight: 20 },
  actions: { gap: 8 },
  tabs: { flexDirection: "row", gap: 8 },
  tab: { flex: 1, alignItems: "center", paddingVertical: 10, borderRadius: 12, backgroundColor: colors.card },
  tabOn: { backgroundColor: colors.raised },
  tabLabel: { color: colors.muted, fontWeight: "700" },
  tabLabelOn: { color: colors.text },
  compose: {
    minHeight: 80,
    color: colors.text,
    backgroundColor: colors.raised,
    borderRadius: 12,
    padding: 12,
    textAlignVertical: "top",
  },
  attachList: { gap: 8 },
  attach: { paddingVertical: 8, paddingHorizontal: 10, borderRadius: 10, backgroundColor: colors.raised },
  attachOn: { backgroundColor: "rgba(127, 208, 239, 0.14)" },
  empty: { gap: 8, backgroundColor: colors.card, borderRadius: 16, padding: 16 },
  emptyTitle: { color: colors.text, fontSize: 18, fontWeight: "700" },
  grid: { gap: 14 },
  clip: { gap: 8, backgroundColor: colors.card, borderRadius: 16, padding: 10 },
  thumbWrap: { position: "relative" },
  clipTitle: { color: colors.text, fontWeight: "800", fontSize: 16 },
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
});
