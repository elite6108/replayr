import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Image } from "expo-image";
import * as Notifications from "expo-notifications";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useFocusEffect, useRouter } from "expo-router";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Avatar } from "@/components/Avatar";
import { NotificationsSheet } from "@/components/NotificationsSheet";
import { ProfileAvatarLink } from "@/components/ProfileAvatarLink";
import { Button, Notice } from "@/components/ui";
import { fetchFriends, socialName, type Friend } from "@/lib/api.friends";
import {
  conversationPeer,
  conversationTitle,
  createConversation,
  fetchConversation,
  fetchConversations,
  lastMessagePreview,
  threadHref,
  upsertConversation,
  type ConversationSummary,
} from "@/lib/api.messages";
import { useAuth } from "@/lib/auth";
import { targetFromPushData } from "@/lib/registerStaffPush";
import { useSocialUnread } from "@/lib/socialUnread";
import { applyRealtimeAuth, getSupabase, supabaseConfigured } from "@/lib/supabase";
import { colors, glow } from "@/lib/theme";

type InboxFilter = "all" | "unread";

function inboxTimestamp(value: string) {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) return "";
  const now = new Date();
  const elapsed = now.getTime() - timestamp.getTime();
  if (elapsed >= 0 && elapsed < 60 * 60 * 1000) {
    const minutes = Math.max(1, Math.floor(elapsed / (60 * 1000)));
    return `${minutes}m ago`;
  }
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const messageDay = new Date(timestamp.getFullYear(), timestamp.getMonth(), timestamp.getDate());
  const days = Math.round((today.getTime() - messageDay.getTime()) / (24 * 60 * 60 * 1000));
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return timestamp.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export default function MessagesScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { session } = useAuth();
  const { notificationsUnread } = useSocialUnread();
  const token = session?.access_token;
  const userId = session?.user.id;
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [friends, setFriends] = useState<Friend[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [compose, setCompose] = useState<"closed" | "dm" | "group">("closed");
  const [picked, setPicked] = useState<string[]>([]);
  const [groupTitle, setGroupTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<InboxFilter>("all");
  const [notificationsOpen, setNotificationsOpen] = useState(false);

  const load = useCallback(async () => {
    if (!token) return;
    setError(null);
    try {
      const [nextConversations, nextFriends] = await Promise.all([
        fetchConversations(token),
        fetchFriends(token).catch(() => [] as Friend[]),
      ]);
      setConversations(nextConversations);
      setFriends(nextFriends);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load messages.");
    } finally {
      setLoading(false);
    }
  }, [token]);

  const refreshInbox = useCallback(async () => {
    if (!token) return;
    try {
      const next = await fetchConversations(token);
      setConversations(next);
    } catch {
      /* next poll or event retries */
    }
  }, [token]);

  const manualRefresh = useCallback(async () => {
    setRefreshing(true);
    await refreshInbox();
    setRefreshing(false);
  }, [refreshInbox]);

  const bumpConversation = useCallback(
    async (conversationKey: string, mine: boolean) => {
      if (!token) return;
      try {
        const summary = await fetchConversation(token, conversationKey);
        setConversations((current) =>
          upsertConversation({ ...summary, unreadCount: mine ? 0 : Math.max(1, summary.unreadCount) }, current),
        );
      } catch {
        void refreshInbox();
      }
    },
    [token, refreshInbox],
  );

  useFocusEffect(
    useCallback(() => {
      if (!token) {
        setLoading(false);
        return;
      }
      void load();
      const timer = setInterval(() => {
        void refreshInbox();
      }, 2000);
      return () => clearInterval(timer);
    }, [token, load, refreshInbox]),
  );

  useEffect(() => {
    if (!token || !userId || !supabaseConfigured()) return;
    const supabase = getSupabase();
    applyRealtimeAuth(token);
    const channel = supabase
      .channel(`messages-inbox:${userId}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" }, (payload) => {
        const row = payload.new as { id?: string; conversation_id?: string; sender_id?: string };
        const conversationKey = row.conversation_id;
        if (!conversationKey || !row.id) return;
        void bumpConversation(conversationKey, row.sender_id === userId);
      })
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications" }, (payload) => {
        const row = payload.new as { kind?: string; conversation_id?: string | null };
        if (row.kind !== "message" || !row.conversation_id) return;
        void bumpConversation(row.conversation_id, false);
      })
      .subscribe((status) => {
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") void refreshInbox();
      });
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [token, userId, bumpConversation, refreshInbox]);

  useEffect(() => {
    if (Platform.OS === "web") return;
    const sub = Notifications.addNotificationReceivedListener((event) => {
      const target = targetFromPushData(event.request.content.data);
      if (target?.kind === "message") void bumpConversation(target.conversationId, false);
    });
    return () => sub.remove();
  }, [bumpConversation]);

  async function openDm(friend: Friend) {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const conversation = friend.dmId
        ? { id: friend.dmId }
        : await createConversation(token, { type: "dm", userId: friend.id });
      setCompose("closed");
      setPicked([]);
      router.push(threadHref(conversation.id));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not open that chat.");
    } finally {
      setBusy(false);
    }
  }

  async function createGroup() {
    if (!token || picked.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const conversation = await createConversation(token, {
        type: "group",
        memberIds: picked,
        title: groupTitle.trim() || null,
      });
      setCompose("closed");
      setPicked([]);
      setGroupTitle("");
      router.push(threadHref(conversation.id));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create that group.");
    } finally {
      setBusy(false);
    }
  }

  function togglePick(id: string) {
    setPicked((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
  }

  const visibleConversations = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return conversations.filter((conversation) => {
      if (filter === "unread" && conversation.unreadCount <= 0) return false;
      if (!needle) return true;
      const searchable = [
        conversationTitle(conversation, userId),
        lastMessagePreview(conversation.lastMessage),
        ...conversation.members.flatMap((member) => [member.username ?? "", member.displayName ?? ""]),
      ]
        .join(" ")
        .toLocaleLowerCase();
      return searchable.includes(needle);
    });
  }, [conversations, filter, query, userId]);

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
        <Text style={styles.hero}>Messages</Text>
        <Text style={styles.muted}>Sign in to chat with people you both follow. Messages stay on your Replayr account.</Text>
        <Button label="Sign in" kind="primary" onPress={() => router.push("/signin")} />
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.page} edges={["top"]}>
      <View style={styles.brandBar}>
        <Image
          source={require("../../assets/images/replayr-logo.png")}
          style={styles.brandLogo}
          contentFit="contain"
          accessibilityLabel="Replayr"
        />
        <View style={styles.brandActions}>
          <Pressable
            style={({ pressed }) => [styles.roundButton, pressed && styles.roundButtonPressed]}
            onPress={() => router.push("/friends")}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Friends"
          >
            <Ionicons name="people-outline" size={20} color={colors.text} />
          </Pressable>
          <Pressable
            style={({ pressed }) => [styles.roundButton, pressed && styles.roundButtonPressed]}
            onPress={() => setNotificationsOpen(true)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Notifications"
          >
            <Ionicons name="notifications-outline" size={21} color={colors.text} />
            {notificationsUnread > 0 ? <View style={styles.notificationPip} /> : null}
          </Pressable>
        </View>
      </View>

      <View style={styles.inboxHead}>
        <Text style={styles.inboxTitle}>Messages</Text>
        <View style={styles.searchRow}>
          <View style={styles.searchBox}>
            <Ionicons name="search-outline" size={18} color={colors.muted} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Search messages"
              placeholderTextColor={colors.muted}
              style={styles.searchInput}
              returnKeyType="search"
              autoCapitalize="none"
              autoCorrect={false}
            />
            {query ? (
              <Pressable onPress={() => setQuery("")} hitSlop={8} accessibilityLabel="Clear search">
                <Ionicons name="close-circle" size={18} color={colors.muted} />
              </Pressable>
            ) : null}
          </View>
          <Pressable
            style={[styles.filterButton, filter === "unread" && styles.filterButtonOn]}
            onPress={() => setFilter((current) => (current === "all" ? "unread" : "all"))}
            accessibilityRole="button"
            accessibilityLabel={filter === "all" ? "Show unread messages" : "Show all messages"}
          >
            <Ionicons name="options-outline" size={20} color={filter === "unread" ? colors.accent : colors.text} />
          </Pressable>
        </View>
        <View style={styles.chips}>
          {(["all", "unread"] as const).map((value) => (
            <Pressable
              key={value}
              style={[styles.chip, filter === value && styles.chipOn]}
              onPress={() => setFilter(value)}
              accessibilityRole="button"
              accessibilityState={{ selected: filter === value }}
            >
              <Text style={[styles.chipText, filter === value && styles.chipTextOn]}>
                {value === "all" ? "All" : "Unread"}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>
      {error ? (
        <View style={styles.notice}>
          <Notice tone="danger">{error}</Notice>
        </View>
      ) : null}
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : (
        <FlatList
          data={visibleConversations}
          keyExtractor={(item) => item.id}
          contentContainerStyle={visibleConversations.length === 0 ? styles.emptyList : styles.list}
          keyboardShouldPersistTaps="handled"
          refreshing={refreshing}
          onRefresh={() => void manualRefresh()}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>
                {conversations.length === 0 ? "No messages yet" : filter === "unread" ? "You're all caught up" : "No matches"}
              </Text>
              <Text style={styles.muted}>
                {conversations.length > 0
                  ? filter === "unread"
                    ? "You have no unread conversations."
                    : "Try another name or message."
                  : friends.length === 0
                    ? "Follow each other to start a chat. Nobody is listed here until you do."
                    : "Start a chat with a friend. Threads you open will show up here."}
              </Text>
              {conversations.length === 0 ? (
                <Button
                  label={friends.length === 0 ? "Find people" : "New message"}
                  kind="primary"
                  onPress={() => (friends.length === 0 ? router.push("/friends") : setCompose("dm"))}
                />
              ) : null}
            </View>
          }
          renderItem={({ item }) => {
            const peer = conversationPeer(item, userId);
            const title = conversationTitle(item, userId);
            return (
              <Pressable style={styles.row} onPress={() => router.push(threadHref(item.id))}>
                <ProfileAvatarLink
                  username={item.type === "dm" ? peer?.username : null}
                  name={title}
                  uri={item.type === "dm" ? peer?.avatarUrl : undefined}
                  size={48}
                />
                <View style={styles.copy}>
                  <View style={styles.rowTop}>
                    <Text style={styles.name} numberOfLines={1}>
                      {title}
                    </Text>
                    <Text style={[styles.time, item.unreadCount > 0 && styles.unreadTime]}>
                      {inboxTimestamp(item.lastMessage?.createdAt || item.updatedAt)}
                    </Text>
                  </View>
                  <Text style={[styles.preview, item.unreadCount > 0 && styles.unreadPreview]} numberOfLines={1}>
                    {lastMessagePreview(item.lastMessage)}
                  </Text>
                </View>
                {item.unreadCount > 0 ? (
                  <View style={styles.unreadBadge}>
                    <Text style={styles.unreadBadgeText}>{item.unreadCount}</Text>
                  </View>
                ) : null}
              </Pressable>
            );
          }}
        />
      )}

      <Pressable
        style={({ pressed }) => [styles.composeButton, pressed && styles.composeButtonPressed]}
        onPress={() => {
          setCompose("dm");
          setPicked([]);
          setGroupTitle("");
        }}
        accessibilityRole="button"
        accessibilityLabel="New message"
      >
        <Ionicons name="create-outline" size={26} color={colors.onAccent} />
      </Pressable>

      <NotificationsSheet visible={notificationsOpen} token={token} onClose={() => setNotificationsOpen(false)} />

      <Modal visible={compose !== "closed"} animationType="slide" transparent onRequestClose={() => setCompose("closed")}>
        <Pressable style={styles.backdrop} onPress={() => setCompose("closed")} />
        <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]}>
          <View style={styles.sheetHead}>
            <Text style={styles.sheetTitle}>{compose === "group" ? "New group" : "New message"}</Text>
            <Pressable onPress={() => setCompose("closed")} hitSlop={8}>
              <Ionicons name="close" size={22} color={colors.text} />
            </Pressable>
          </View>
          {friends.length === 0 ? (
            <View style={styles.empty}>
              <Text style={styles.muted}>No mutual follows yet. Find someone by username first.</Text>
              <Button
                label="Find people"
                kind="primary"
                onPress={() => {
                  setCompose("closed");
                  router.push("/friends");
                }}
              />
            </View>
          ) : (
            <>
              {compose === "group" ? (
                <TextInput
                  value={groupTitle}
                  onChangeText={setGroupTitle}
                  placeholder="Group name (optional)"
                  placeholderTextColor={colors.muted}
                  style={styles.input}
                  maxLength={64}
                />
              ) : (
                <Pressable onPress={() => setCompose("group")}>
                  <Text style={styles.link}>New group</Text>
                </Pressable>
              )}
              <FlatList
                data={friends}
                keyExtractor={(item) => item.id}
                style={styles.sheetList}
                renderItem={({ item }) => {
                  const selected = picked.includes(item.id);
                  return (
                    <Pressable
                      style={styles.friendRow}
                      disabled={busy}
                      onPress={() => (compose === "group" ? togglePick(item.id) : void openDm(item))}
                    >
                      <Avatar name={socialName(item)} uri={item.avatarUrl} size={40} />
                      <View style={styles.copy}>
                        <Text style={styles.name}>{socialName(item)}</Text>
                        {item.username ? <Text style={styles.muted}>@{item.username}</Text> : null}
                      </View>
                      {compose === "group" ? (
                        <Ionicons
                          name={selected ? "checkmark-circle" : "ellipse-outline"}
                          size={22}
                          color={selected ? colors.accent : colors.muted}
                        />
                      ) : (
                        <Ionicons name="chevron-forward" size={18} color={colors.muted} />
                      )}
                    </Pressable>
                  );
                }}
              />
              {compose === "group" ? (
                <Button
                  label={busy ? "Creating…" : picked.length === 0 ? "Pick at least one friend" : "Create group"}
                  kind="primary"
                  disabled={busy || picked.length === 0}
                  onPress={() => void createGroup()}
                />
              ) : null}
            </>
          )}
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, backgroundColor: colors.bg, padding: 24, gap: 12, justifyContent: "center" },
  hero: { color: colors.text, fontSize: 28, fontWeight: "700" },
  muted: { color: colors.muted, fontSize: 14, lineHeight: 20 },
  brandBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingTop: 2,
    paddingBottom: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.accentRing,
  },
  brandLogo: { width: 132, height: 38 },
  brandActions: { flexDirection: "row", alignItems: "center", gap: 10 },
  roundButton: {
    position: "relative",
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.chrome,
  },
  roundButtonPressed: { borderColor: colors.accentRing, backgroundColor: colors.raised },
  notificationPip: {
    position: "absolute",
    top: 6,
    right: 6,
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: colors.accent,
  },
  inboxHead: { paddingHorizontal: 20, paddingTop: 20, paddingBottom: 14, gap: 14 },
  inboxTitle: { color: colors.text, fontSize: 28, lineHeight: 34, fontWeight: "800", letterSpacing: -0.5 },
  searchRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  searchBox: {
    flex: 1,
    minHeight: 46,
    borderRadius: 23,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.chrome,
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    paddingHorizontal: 14,
  },
  searchInput: { flex: 1, color: colors.text, fontSize: 14, paddingVertical: 10 },
  filterButton: {
    width: 46,
    height: 46,
    borderRadius: 23,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.chrome,
    alignItems: "center",
    justifyContent: "center",
  },
  filterButtonOn: { borderColor: colors.accentRing, backgroundColor: colors.accentDim },
  chips: { flexDirection: "row", alignItems: "center", gap: 8 },
  chip: {
    borderRadius: 18,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 13,
    paddingVertical: 7,
    backgroundColor: colors.chrome,
  },
  chipOn: { borderColor: colors.raised, backgroundColor: colors.raised },
  chipText: { color: colors.muted, fontSize: 13, fontWeight: "600" },
  chipTextOn: { color: colors.text },
  list: { paddingHorizontal: 18, paddingBottom: 94 },
  emptyList: { flexGrow: 1, justifyContent: "center", paddingHorizontal: 24, paddingBottom: 76 },
  empty: { gap: 12 },
  emptyTitle: { color: colors.text, fontSize: 20, fontWeight: "700" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 72,
    marginBottom: 10,
    paddingHorizontal: 12,
    paddingVertical: 11,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.raised,
  },
  copy: { flex: 1, gap: 3, minWidth: 0 },
  rowTop: { flexDirection: "row", alignItems: "center", gap: 8 },
  name: { color: colors.text, fontWeight: "700", fontSize: 15, flex: 1 },
  time: { color: colors.muted, fontSize: 12 },
  unreadTime: { color: colors.accent },
  preview: { color: colors.muted, fontSize: 13 },
  unreadPreview: { color: colors.text, fontWeight: "600" },
  unreadBadge: {
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    paddingHorizontal: 5,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.accent,
  },
  unreadBadgeText: { color: colors.onAccent, fontSize: 11, fontWeight: "900" },
  composeButton: {
    position: "absolute",
    right: 22,
    bottom: 18,
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
    ...glow,
    shadowOpacity: 0.5,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
    elevation: 10,
  },
  composeButtonPressed: { opacity: 0.82, transform: [{ scale: 0.97 }] },
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: "#00000088" },
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    maxHeight: "78%",
    backgroundColor: colors.card,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 16,
    gap: 12,
  },
  sheetHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  sheetTitle: { color: colors.text, fontSize: 18, fontWeight: "700" },
  sheetList: { maxHeight: 360 },
  friendRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10 },
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
  link: { color: colors.accent, fontWeight: "700", fontSize: 15 },
  notice: { paddingHorizontal: 16 },
});
