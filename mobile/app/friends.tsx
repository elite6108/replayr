import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { Avatar } from "@/components/Avatar";
import { Button, Notice } from "@/components/ui";
import {
  acceptFriendRequest,
  blockUser,
  cancelFriendRequest,
  declineFriendRequest,
  fetchFriendRequests,
  fetchUserSuggestions,
  searchUsers,
  socialHandle,
  socialName,
  type FriendRequest,
  type Relationship,
  type SocialUser,
} from "@/lib/api.friends";
import { fetchFollowers, fetchFollowing, followUser, unfollowUser, type FollowListItem } from "@/lib/api.follows";
import { createConversation, threadHref } from "@/lib/api.messages";
import { useAuth } from "@/lib/auth";
import { useSocialUnread } from "@/lib/socialUnread";
import { colors } from "@/lib/theme";

type Tab = "following" | "followers" | "requests" | "find";
type SearchHit = SocialUser & { relationship: Relationship };

const TABS: { id: Tab; label: string }[] = [
  { id: "following", label: "Following" },
  { id: "followers", label: "Followers" },
  { id: "requests", label: "Requests" },
  { id: "find", label: "Find" },
];

export default function FriendsScreen() {
  const router = useRouter();
  const { session } = useAuth();
  const token = session?.access_token;
  const { setFriendsUnread } = useSocialUnread();
  const [tab, setTab] = useState<Tab>("following");
  const [following, setFollowing] = useState<FollowListItem[]>([]);
  const [followers, setFollowers] = useState<FollowListItem[]>([]);
  const [incoming, setIncoming] = useState<FriendRequest[]>([]);
  const [outgoing, setOutgoing] = useState<FriendRequest[]>([]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchHit[]>([]);
  const [suggestions, setSuggestions] = useState<SearchHit[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    setError(null);
    try {
      const [nextFollowing, nextFollowers, requests] = await Promise.all([
        fetchFollowing(token),
        fetchFollowers(token),
        fetchFriendRequests(token),
      ]);
      setFollowing(nextFollowing);
      setFollowers(nextFollowers);
      setIncoming(requests.incoming);
      setOutgoing(requests.outgoing);
      setFriendsUnread(requests.incoming.length > 0);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load follows.");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useFocusEffect(
    useCallback(() => {
      if (!token) {
        setLoading(false);
        return;
      }
      void load();
    }, [token, load]),
  );

  useEffect(() => {
    if (!token || tab !== "find") return;
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
    if (!token || tab !== "find") return;
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

  async function openDm(userId: string, dmId?: string | null) {
    if (!token) return;
    setBusyId(userId);
    try {
      const conversation = dmId
        ? { id: dmId }
        : await createConversation(token, { type: "dm", userId });
      router.push(threadHref(conversation.id));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not open that chat.");
    } finally {
      setBusyId(null);
    }
  }

  function confirmFollowActions(person: FollowListItem) {
    if (!token || !person.username) return;
    Alert.alert(socialName(person), "Unfollow or block this account.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Unfollow",
        onPress: () => {
          void unfollowUser(token, person.username as string)
            .then(() => setFollowing((current) => current.filter((item) => item.id !== person.id)))
            .catch((caught) => setError(caught instanceof Error ? caught.message : "Could not unfollow."));
        },
      },
      {
        text: "Block",
        style: "destructive",
        onPress: () => {
          void blockUser(token, person.id)
            .then(() => {
              setFollowing((current) => current.filter((item) => item.id !== person.id));
              setFollowers((current) => current.filter((item) => item.id !== person.id));
            })
            .catch((caught) => setError(caught instanceof Error ? caught.message : "Could not block that account."));
        },
      },
    ]);
  }

  async function onAccept(request: FriendRequest) {
    if (!token) return;
    setBusyId(request.id);
    try {
      await acceptFriendRequest(token, request.id);
      setIncoming((current) => current.filter((item) => item.id !== request.id));
      if (request.from) setFollowers((current) => [ { ...request.from, since: new Date().toISOString() }, ...current.filter((item) => item.id !== request.from.id)]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not accept that request.");
    } finally {
      setBusyId(null);
    }
  }

  async function onDecline(request: FriendRequest) {
    if (!token) return;
    setBusyId(request.id);
    try {
      await declineFriendRequest(token, request.id);
      setIncoming((current) => current.filter((item) => item.id !== request.id));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not decline that request.");
    } finally {
      setBusyId(null);
    }
  }

  async function onCancel(request: FriendRequest) {
    if (!token) return;
    setBusyId(request.id);
    try {
      await cancelFriendRequest(token, request.id);
      setOutgoing((current) => current.filter((item) => item.id !== request.id));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not cancel that request.");
    } finally {
      setBusyId(null);
    }
  }

  async function onAdd(user: SearchHit) {
    if (!token) return;
    setBusyId(user.id);
    try {
      if (!user.username) throw new Error("That account has no username.");
      const result = await followUser(token, user.username);
      const nextRel = result.follow.viewerFollowPending ? "outgoing" : result.follow.viewerFollows ? "following" : "none";
      setResults((current) => current.map((item) => (item.id === user.id ? { ...item, relationship: nextRel } : item)));
      if (result.follow.viewerFollows) {
        setFollowing((current) => [{ ...user, since: new Date().toISOString() }, ...current.filter((item) => item.id !== user.id)]);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not follow that account.");
    } finally {
      setBusyId(null);
    }
  }

  if (session === undefined) {
    return (
      <View style={styles.center}>
        <Text style={styles.muted}>Loading…</Text>
      </View>
    );
  }

  if (!session) {
    return (
      <View style={styles.center}>
        <Text style={styles.title}>Following</Text>
        <Text style={styles.muted}>Sign in to follow people and see requests. This list stays empty until you do.</Text>
        <Button label="Sign in" kind="primary" onPress={() => router.push("/signin")} />
      </View>
    );
  }

  const requestCount = incoming.length + outgoing.length;

  return (
    <View style={styles.page}>
      <View style={styles.tabs}>
        {TABS.map((item) => {
          const active = tab === item.id;
          const badge = item.id === "requests" && incoming.length > 0 ? incoming.length : 0;
          return (
            <Pressable key={item.id} style={[styles.tab, active && styles.tabOn]} onPress={() => setTab(item.id)}>
              <Text style={[styles.tabLabel, active && styles.tabLabelOn]}>
                {item.label}
                {item.id === "requests" && requestCount > 0 ? ` · ${requestCount}` : ""}
              </Text>
              {badge > 0 && !active ? <View style={styles.pip} /> : null}
            </Pressable>
          );
        })}
      </View>
      <Notice tone="danger">{error}</Notice>
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : tab === "following" || tab === "followers" ? (
        <FlatList
          data={tab === "following" ? following : followers}
          keyExtractor={(item) => item.id}
          contentContainerStyle={(tab === "following" ? following : followers).length === 0 ? styles.emptyList : styles.list}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>{tab === "following" ? "Not following anyone" : "No followers yet"}</Text>
              <Text style={styles.muted}>
                {tab === "following"
                  ? "Search by username on Find. Replayr does not invent people to follow."
                  : "When someone follows you, they show up here."}
              </Text>
              {tab === "following" ? <Button label="Find people" kind="primary" onPress={() => setTab("find")} /> : null}
            </View>
          }
          renderItem={({ item }) => (
            <Pressable
              style={styles.row}
              onLongPress={() => confirmFollowActions(item)}
              onPress={() => {
                if (item.username) router.push(`/u/${item.username}`);
              }}
            >
              <Avatar name={socialName(item)} uri={item.avatarUrl} size={44} />
              <View style={styles.copy}>
                <Text style={styles.name}>{socialName(item)}</Text>
                {socialHandle(item) ? <Text style={styles.muted}>{socialHandle(item)}</Text> : null}
              </View>
              {tab === "following" ? (
                <Text style={styles.muted}>Following</Text>
              ) : following.some((entry) => entry.id === item.id) ? (
                <Text style={styles.muted}>Following</Text>
              ) : (
                <Pressable
                  style={styles.pill}
                  disabled={busyId === item.id}
                  onPress={(event) => {
                    event.stopPropagation();
                    if (!item.username) return;
                    void onAdd({ ...item, relationship: "follower" });
                  }}
                >
                  <Text style={styles.pillText}>{busyId === item.id ? "…" : "Follow back"}</Text>
                </Pressable>
              )}
            </Pressable>
          )}
        />
      ) : tab === "requests" ? (
        <FlatList
          data={[
            ...incoming.map((item) => ({ kind: "in" as const, item })),
            ...outgoing.map((item) => ({ kind: "out" as const, item })),
          ]}
          keyExtractor={(row) => `${row.kind}-${row.item.id}`}
          contentContainerStyle={requestCount === 0 ? styles.emptyList : styles.list}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>No requests</Text>
              <Text style={styles.muted}>Incoming and sent requests show up here. Nothing is waiting right now.</Text>
            </View>
          }
          renderItem={({ item: row }) => {
            const person = row.kind === "in" ? row.item.from : row.item.to;
            const busy = busyId === row.item.id;
            return (
              <Pressable
                style={styles.row}
                onPress={() => {
                  if (person.username) router.push(`/u/${person.username}`);
                }}
              >
                <Avatar name={socialName(person)} uri={person.avatarUrl} size={44} />
                <View style={styles.copy}>
                  <Text style={styles.name}>{socialName(person)}</Text>
                  <Text style={styles.muted}>{row.kind === "in" ? "Wants to follow you" : "Requested"}</Text>
                </View>
                {row.kind === "in" ? (
                  <View style={styles.actions}>
                    <Pressable
                      style={styles.pill}
                      disabled={busy}
                      onPress={(event) => {
                        event.stopPropagation();
                        void onAccept(row.item);
                      }}
                    >
                      <Text style={styles.pillText}>{busy ? "…" : "Accept"}</Text>
                    </Pressable>
                    <Pressable
                      style={styles.ghost}
                      disabled={busy}
                      onPress={(event) => {
                        event.stopPropagation();
                        void onDecline(row.item);
                      }}
                    >
                      <Text style={styles.ghostText}>Decline</Text>
                    </Pressable>
                  </View>
                ) : (
                  <Pressable
                    style={styles.ghost}
                    disabled={busy}
                    onPress={(event) => {
                      event.stopPropagation();
                      void onCancel(row.item);
                    }}
                  >
                    <Text style={styles.ghostText}>{busy ? "…" : "Cancel"}</Text>
                  </Pressable>
                )}
              </Pressable>
            );
          }}
        />
      ) : (
        <FlatList
          data={query.trim().length >= 2 ? results : suggestions}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          ListHeaderComponent={
            <View style={styles.findHead}>
              <TextInput
                value={query}
                onChangeText={setQuery}
                placeholder="Search by username"
                placeholderTextColor={colors.muted}
                autoCapitalize="none"
                autoCorrect={false}
                style={styles.input}
              />
              <Text style={styles.muted}>
                {query.trim().length < 2
                  ? "Type at least two characters, or add someone who plays the same games."
                  : "Search results"}
              </Text>
              {searching ? <ActivityIndicator color={colors.accent} /> : null}
              {query.trim().length < 2 && suggestions.length > 0 ? (
                <Text style={styles.name}>Plays the same games</Text>
              ) : null}
            </View>
          }
          ListEmptyComponent={
            query.trim().length >= 2 && !searching ? (
              <Text style={styles.muted}>No accounts match that username.</Text>
            ) : query.trim().length < 2 ? (
              <Text style={styles.muted}>Find someone by the username they set on Replayr.</Text>
            ) : null
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
              <RelationAction
                user={item}
                busy={busyId === item.id}
                onAdd={() => void onAdd(item)}
                onMessage={() => {
                  void openDm(item.id);
                }}
              />
            </Pressable>
          )}
        />
      )}
    </View>
  );
}

function RelationAction({
  user,
  busy,
  onAdd,
  onMessage,
}: {
  user: SearchHit;
  busy: boolean;
  onAdd: () => void;
  onMessage: () => void;
}) {
  if (user.relationship === "friends") {
    return (
      <Pressable
        style={styles.pill}
        disabled={busy}
        onPress={(event) => {
          event.stopPropagation();
          onMessage();
        }}
      >
        <Text style={styles.pillText}>Message</Text>
      </Pressable>
    );
  }
  if (user.relationship === "following") {
    return <Text style={styles.muted}>Following</Text>;
  }
  if (user.relationship === "outgoing") {
    return <Text style={styles.muted}>Requested</Text>;
  }
  if (user.relationship === "incoming") {
    return <Text style={styles.muted}>Responds in Requests</Text>;
  }
  return (
    <Pressable
      style={styles.pill}
      disabled={busy}
      onPress={(event) => {
        event.stopPropagation();
        onAdd();
      }}
    >
      <Text style={styles.pillText}>{busy ? "…" : user.relationship === "follower" ? "Follow back" : "Follow"}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg, paddingHorizontal: 16, paddingTop: 12, gap: 12 },
  center: { flex: 1, backgroundColor: colors.bg, padding: 16, gap: 12, justifyContent: "center" },
  title: { color: colors.text, fontSize: 24, fontWeight: "700" },
  muted: { color: colors.muted, fontSize: 14, lineHeight: 20 },
  tabs: {
    flexDirection: "row",
    backgroundColor: colors.raised,
    borderRadius: 22,
    padding: 4,
    gap: 4,
  },
  tab: {
    flex: 1,
    borderRadius: 18,
    paddingVertical: 8,
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "center",
    gap: 6,
  },
  tabOn: { backgroundColor: colors.accent },
  tabLabel: { color: colors.muted, fontWeight: "700", fontSize: 13 },
  tabLabelOn: { color: colors.onAccent },
  pip: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.accent },
  list: { paddingBottom: 32, gap: 4 },
  emptyList: { flexGrow: 1, justifyContent: "center", paddingBottom: 40 },
  empty: { gap: 12, alignItems: "flex-start" },
  emptyTitle: { color: colors.text, fontSize: 20, fontWeight: "700" },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10 },
  copy: { flex: 1, gap: 2 },
  name: { color: colors.text, fontWeight: "700", fontSize: 16 },
  actions: { flexDirection: "row", gap: 8, alignItems: "center" },
  pill: {
    backgroundColor: colors.accent,
    borderRadius: 18,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  pillText: { color: colors.onAccent, fontWeight: "700", fontSize: 13 },
  ghost: {
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 18,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: colors.raised,
  },
  ghostText: { color: colors.text, fontWeight: "600", fontSize: 13 },
  findHead: { gap: 10, marginBottom: 8 },
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
});
