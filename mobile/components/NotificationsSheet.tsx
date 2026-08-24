import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Avatar } from "@/components/Avatar";
import {
  acceptFriendRequest,
  declineFriendRequest,
  fetchFriendRequests,
  fetchNotifications,
  readNotifications,
  socialName,
  type NotificationItem,
} from "@/lib/api.friends";
import { threadHref } from "@/lib/api.messages";
import { formatTimeAgo } from "@/lib/format";
import { useSocialUnread } from "@/lib/socialUnread";
import { colors } from "@/lib/theme";

function copyFor(item: NotificationItem) {
  const name = socialName(item.actor);
  if (item.kind === "friend_request") return `${name} sent a friend request`;
  if (item.kind === "friend_accept") return `${name} accepted your request`;
  if (item.kind === "group_invite") return `${name} invited you to a group`;
  if (item.kind === "clip_like") return `${name} liked your clip`;
  if (item.kind === "clip_comment") return `${name} commented on your clip`;
  return `${name} sent you a message`;
}

export function NotificationsSheet({
  visible,
  token,
  onClose,
}: {
  visible: boolean;
  token?: string | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { setFriendsUnread, setNotificationsUnread } = useSocialUnread();
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (!visible || !token) {
      if (!visible) setItems([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void fetchNotifications(token)
      .then(async (notifications) => {
        if (cancelled) return;
        setItems(notifications);
        const unreadIds = notifications.filter((item) => !item.readAt).map((item) => item.id);
        setNotificationsUnread(0);
        if (unreadIds.length > 0) {
          await readNotifications(token, unreadIds).catch(() => undefined);
        }
      })
      .catch((caught) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Could not load notifications.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [visible, token, setNotificationsUnread]);

  async function refreshFriendsFlag() {
    if (!token) return;
    const requests = await fetchFriendRequests(token).catch(() => ({ incoming: [], outgoing: [] }));
    setFriendsUnread(requests.incoming.length > 0);
  }

  async function onAccept(item: NotificationItem) {
    if (!token || !item.friendshipId) return;
    setBusyId(item.id);
    try {
      await acceptFriendRequest(token, item.friendshipId);
      setItems((current) => current.filter((row) => row.id !== item.id));
      await refreshFriendsFlag();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not accept that request.");
    } finally {
      setBusyId(null);
    }
  }

  async function onDecline(item: NotificationItem) {
    if (!token || !item.friendshipId) return;
    setBusyId(item.id);
    try {
      await declineFriendRequest(token, item.friendshipId);
      setItems((current) => current.filter((row) => row.id !== item.id));
      await refreshFriendsFlag();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not decline that request.");
    } finally {
      setBusyId(null);
    }
  }

  function openItem(item: NotificationItem) {
    onClose();
    if (item.kind === "friend_request") {
      router.push("/friends");
      return;
    }
    if (item.kind === "friend_accept" && item.actor?.username) {
      router.push(`/u/${item.actor.username}`);
      return;
    }
    if ((item.kind === "message" || item.kind === "group_invite") && item.conversationId) {
      router.push(threadHref(item.conversationId));
      return;
    }
    if ((item.kind === "clip_like" || item.kind === "clip_comment") && item.clipSlug) {
      router.push(`/c/${item.clipSlug}`);
    }
  }

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <Pressable style={styles.dismiss} onPress={onClose} />
        <View style={[styles.sheet, { paddingBottom: Math.max(16, insets.bottom + 8) }]}>
          <View style={styles.handle} />
          <View style={styles.head}>
            <Text style={styles.title}>Notifications</Text>
            <Pressable onPress={onClose} hitSlop={8}>
              <Text style={styles.done}>Done</Text>
            </Pressable>
          </View>
          {error ? <Text style={styles.error}>{error}</Text> : null}
          {loading ? (
            <ActivityIndicator color={colors.accent} style={styles.spinner} />
          ) : items.length === 0 ? (
            <Text style={styles.empty}>You’re all caught up.</Text>
          ) : (
            <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
              {items.map((item) => {
                const name = socialName(item.actor);
                const busy = busyId === item.id;
                return (
                  <Pressable key={item.id} style={styles.row} onPress={() => openItem(item)}>
                    <Avatar name={name} uri={item.actor?.avatarUrl} size={44} />
                    <View style={styles.copy}>
                      <Text style={styles.body}>{copyFor(item)}</Text>
                      <Text style={styles.time}>{formatTimeAgo(item.createdAt)}</Text>
                    </View>
                    {item.kind === "friend_request" && item.friendshipId ? (
                      <View style={styles.actions}>
                        <Pressable
                          style={styles.pill}
                          disabled={busy}
                          onPress={(event) => {
                            event.stopPropagation();
                            void onAccept(item);
                          }}
                        >
                          <Text style={styles.pillText}>{busy ? "…" : "Accept"}</Text>
                        </Pressable>
                        <Pressable
                          style={styles.ghost}
                          disabled={busy}
                          onPress={(event) => {
                            event.stopPropagation();
                            void onDecline(item);
                          }}
                        >
                          <Text style={styles.ghostText}>Decline</Text>
                        </Pressable>
                      </View>
                    ) : null}
                  </Pressable>
                );
              })}
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: "flex-end", backgroundColor: "#00000088" },
  dismiss: { flex: 1 },
  sheet: {
    backgroundColor: colors.bg,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: "78%",
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  handle: {
    alignSelf: "center",
    width: 42,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border,
    marginBottom: 10,
  },
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 },
  title: { color: colors.text, fontSize: 20, fontWeight: "800" },
  done: { color: colors.accent, fontWeight: "700", fontSize: 16 },
  error: { color: colors.danger, marginBottom: 8 },
  spinner: { marginVertical: 28 },
  empty: { color: colors.muted, paddingVertical: 28, lineHeight: 20 },
  list: { maxHeight: 520 },
  listContent: { paddingBottom: 12, gap: 4 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10 },
  copy: { flex: 1, gap: 2 },
  body: { color: colors.text, fontWeight: "700", fontSize: 15 },
  time: { color: colors.muted, fontSize: 12 },
  actions: { gap: 6 },
  pill: { backgroundColor: "#ffffff", borderRadius: 16, paddingHorizontal: 10, paddingVertical: 6 },
  pillText: { color: "#07080b", fontWeight: "700", fontSize: 12 },
  ghost: {
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 16,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: colors.raised,
    alignItems: "center",
  },
  ghostText: { color: colors.text, fontWeight: "600", fontSize: 12 },
});
