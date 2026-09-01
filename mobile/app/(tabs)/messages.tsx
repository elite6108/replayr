import { useCallback, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useFocusEffect, useRouter } from "expo-router";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Avatar } from "@/components/Avatar";
import { ProfileAvatarLink } from "@/components/ProfileAvatarLink";
import { Button, Notice } from "@/components/ui";
import { fetchFriends, socialName, type Friend } from "@/lib/api.friends";
import {
  conversationPeer,
  conversationTitle,
  createConversation,
  fetchConversations,
  lastMessagePreview,
  threadHref,
  type ConversationSummary,
} from "@/lib/api.messages";
import { useAuth } from "@/lib/auth";
import { formatTimeAgo } from "@/lib/format";
import { colors } from "@/lib/theme";

export default function MessagesScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { session } = useAuth();
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

  useFocusEffect(
    useCallback(() => {
      if (!token) {
        setLoading(false);
        return;
      }
      void load();
    }, [token, load]),
  );

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
      <View style={styles.topBar}>
        <Pressable onPress={() => router.push("/friends")} hitSlop={8}>
          <Ionicons name="people-outline" size={24} color={colors.text} />
        </Pressable>
        <Text style={styles.topTitle}>Messages</Text>
        <Pressable
          onPress={() => {
            setCompose("dm");
            setPicked([]);
            setGroupTitle("");
          }}
          hitSlop={8}
        >
          <Ionicons name="create-outline" size={24} color={colors.text} />
        </Pressable>
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
          data={conversations}
          keyExtractor={(item) => item.id}
          contentContainerStyle={conversations.length === 0 ? styles.emptyList : styles.list}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>No messages yet</Text>
              <Text style={styles.muted}>
                {friends.length === 0
                  ? "Follow each other to start a chat. Nobody is listed here until you do."
                  : "Start a chat with a friend. Threads you open will show up here."}
              </Text>
              <Button
                label={friends.length === 0 ? "Find people" : "New message"}
                kind="primary"
                onPress={() => (friends.length === 0 ? router.push("/friends") : setCompose("dm"))}
              />
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
                    <Text style={styles.time}>{formatTimeAgo(item.lastMessage?.createdAt || item.updatedAt)}</Text>
                  </View>
                  <Text style={[styles.preview, item.unreadCount > 0 && styles.unreadPreview]} numberOfLines={1}>
                    {lastMessagePreview(item.lastMessage)}
                  </Text>
                </View>
                {item.unreadCount > 0 ? <View style={styles.pip} /> : null}
              </Pressable>
            );
          }}
        />
      )}

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
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  topTitle: { color: colors.text, fontSize: 18, fontWeight: "700" },
  list: { paddingHorizontal: 16, paddingBottom: 32 },
  emptyList: { flexGrow: 1, justifyContent: "center", padding: 24 },
  empty: { gap: 12 },
  emptyTitle: { color: colors.text, fontSize: 20, fontWeight: "700" },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12 },
  copy: { flex: 1, gap: 3, minWidth: 0 },
  rowTop: { flexDirection: "row", alignItems: "center", gap: 8 },
  name: { color: colors.text, fontWeight: "700", fontSize: 16, flex: 1 },
  time: { color: colors.muted, fontSize: 12 },
  preview: { color: colors.muted, fontSize: 14 },
  unreadPreview: { color: colors.text, fontWeight: "600" },
  pip: { width: 9, height: 9, borderRadius: 5, backgroundColor: colors.accent },
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
