import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Avatar } from "@/components/Avatar";
import { fetchFriends, socialHandle, socialName, type Friend } from "@/lib/api.friends";
import {
  conversationTitle,
  createConversation,
  fetchConversations,
  sendClipToConversation,
  type ConversationSummary,
} from "@/lib/api.messages";
import { useAuth } from "@/lib/auth";
import { colors } from "@/lib/theme";

type Target =
  | { kind: "chat"; id: string; label: string }
  | { kind: "friend"; id: string; label: string };

export function SendClipSheet({
  slug,
  visible,
  onClose,
}: {
  slug: string;
  visible: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { session } = useAuth();
  const token = session?.access_token;
  const myId = session?.user.id;
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [friends, setFriends] = useState<Friend[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<Target | null>(null);

  useEffect(() => {
    if (!visible) return;
    setPicked(null);
    setError(null);
    if (!token) return;
    let cancelled = false;
    setLoading(true);
    void Promise.all([fetchConversations(token), fetchFriends(token)])
      .then(([nextConversations, nextFriends]) => {
        if (cancelled) return;
        setConversations(nextConversations);
        setFriends(nextFriends);
      })
      .catch((caught) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Could not load people to send to.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [visible, token]);

  const friendTargets = useMemo(() => {
    const shown = new Set(conversations.map((item) => item.id));
    return friends.filter((friend) => !friend.dmId || !shown.has(friend.dmId));
  }, [conversations, friends]);

  async function send() {
    if (!token || !picked) {
      onClose();
      router.push("/signin");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const conversationId =
        picked.kind === "chat"
          ? picked.id
          : friends.find((friend) => friend.id === picked.id)?.dmId ??
            (await createConversation(token, { type: "dm", userId: picked.id })).id;
      await sendClipToConversation(token, slug, { conversationId });
      onClose();
      Alert.alert("Sent", `Sent to ${picked.label}. The clip stays private to that chat.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not send that clip.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <Pressable style={styles.backdrop} onPress={onClose} />
        <View style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]}>
          <Text style={styles.title}>Send clip</Text>
          <Text style={styles.muted}>Recent chats, then people you both follow. Sending does not make the clip public.</Text>
          {error ? <Text style={styles.error}>{error}</Text> : null}
          {!token ? (
            <Text style={styles.muted}>Sign in to send this clip. Copy link still works.</Text>
          ) : loading ? (
            <ActivityIndicator color={colors.accent} style={{ marginVertical: 24 }} />
          ) : conversations.length === 0 && friends.length === 0 ? (
            <Text style={styles.muted}>Follow each other to send clips.</Text>
          ) : (
            <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
              {conversations.length > 0 ? <Text style={styles.heading}>Recent chats</Text> : null}
              {conversations.map((conversation) => {
                const label = conversationTitle(conversation, myId);
                const person = conversation.members.find((member) => member.id !== myId) ?? conversation.members[0];
                const selected = picked?.kind === "chat" && picked.id === conversation.id;
                return (
                  <Pressable
                    key={conversation.id}
                    style={[styles.row, selected && styles.rowOn]}
                    onPress={() => setPicked({ kind: "chat", id: conversation.id, label })}
                  >
                    <Avatar name={person ? socialName(person) : label} uri={person?.avatarUrl} size={40} />
                    <View style={styles.copy}>
                      <Text style={styles.name}>{label}</Text>
                      <Text style={styles.muted}>{conversation.type === "group" ? "Group" : "Chat"}</Text>
                    </View>
                  </Pressable>
                );
              })}
              {friendTargets.length > 0 ? <Text style={styles.heading}>People you both follow</Text> : null}
              {friendTargets.map((friend) => {
                const selected = picked?.kind === "friend" && picked.id === friend.id;
                return (
                  <Pressable
                    key={friend.id}
                    style={[styles.row, selected && styles.rowOn]}
                    onPress={() => setPicked({ kind: "friend", id: friend.id, label: socialName(friend) })}
                  >
                    <Avatar name={socialName(friend)} uri={friend.avatarUrl} size={40} />
                    <View style={styles.copy}>
                      <Text style={styles.name}>{socialName(friend)}</Text>
                      {socialHandle(friend) ? <Text style={styles.muted}>{socialHandle(friend)}</Text> : null}
                    </View>
                  </Pressable>
                );
              })}
            </ScrollView>
          )}
          <View style={styles.actions}>
            <Pressable
              style={[styles.primary, (!token || !picked || busy) && styles.disabled]}
              disabled={busy}
              onPress={() => void send()}
            >
              <Text style={styles.primaryText}>
                {busy ? "Sending…" : !token ? "Sign in to send" : picked ? `Send to ${picked.label}` : "Pick someone"}
              </Text>
            </Pressable>
            <Pressable style={styles.ghost} onPress={onClose}>
              <Text style={styles.ghostText}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: "flex-end", backgroundColor: "#00000088" },
  backdrop: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 },
  sheet: {
    backgroundColor: colors.raised,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    padding: 18,
    maxHeight: "84%",
    gap: 10,
  },
  title: { color: colors.text, fontSize: 22, fontWeight: "700" },
  muted: { color: colors.muted, fontSize: 14, lineHeight: 20 },
  error: { color: colors.danger, fontSize: 14 },
  list: { maxHeight: 360 },
  listContent: { gap: 4, paddingBottom: 8 },
  heading: { color: colors.muted, fontSize: 12, fontWeight: "700", marginTop: 10, marginBottom: 4, textTransform: "uppercase" },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10, paddingHorizontal: 8, borderRadius: 14 },
  rowOn: { backgroundColor: colors.accentDim },
  copy: { flex: 1, gap: 2 },
  name: { color: colors.text, fontWeight: "700", fontSize: 16 },
  actions: { gap: 8, marginTop: 8 },
  primary: { backgroundColor: colors.accent, borderRadius: 999, paddingVertical: 12, alignItems: "center" },
  primaryText: { color: colors.onAccent, fontWeight: "700" },
  disabled: { opacity: 0.45 },
  ghost: { alignItems: "center", paddingVertical: 10 },
  ghostText: { color: colors.text, fontWeight: "600" },
});
