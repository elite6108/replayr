import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Avatar } from "@/components/Avatar";
import { ClipThumb } from "@/components/ClipThumb";
import { Notice } from "@/components/ui";
import { socialName } from "@/lib/api.friends";
import {
  conversationTitle,
  fetchConversation,
  fetchMessages,
  leaveConversation,
  postMessage,
  type ChatMessage,
  type ConversationSummary,
  type MessageClip,
} from "@/lib/api.messages";
import { useAuth } from "@/lib/auth";
import { useSocialUnread } from "@/lib/socialUnread";
import { formatDurationMs, formatTimeAgo } from "@/lib/format";
import { colors } from "@/lib/theme";

function firstParam(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

export default function ThreadScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const conversationId = firstParam(params.id);
  const { session } = useAuth();
  const token = session?.access_token;
  const userId = session?.user.id;
  const { setActiveConversation, markConversationRead } = useSocialUnread();
  const [conversation, setConversation] = useState<ConversationSummary | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [busy, setBusy] = useState(false);

  const title = conversation ? conversationTitle(conversation, userId) : "Chat";

  const load = useCallback(async () => {
    if (!token || !conversationId) return;
    setError(null);
    try {
      const [nextConversation, nextMessages] = await Promise.all([
        fetchConversation(token, conversationId),
        fetchMessages(token, conversationId, { limit: 50 }),
      ]);
      setConversation(nextConversation);
      setMessages(nextMessages);
      setHasMore(nextMessages.length >= 50);
      setActiveConversation(conversationId);
      markConversationRead(conversationId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load that chat.");
    } finally {
      setLoading(false);
    }
  }, [token, conversationId]);

  useEffect(() => {
    if (!token) {
      setLoading(false);
      return;
    }
    void load();
    return () => setActiveConversation(null);
  }, [token, load, setActiveConversation]);

  async function loadOlder() {
    if (!token || !conversationId || loading || loadingMore || !hasMore || messages.length === 0) return;
    setLoadingMore(true);
    try {
      const older = await fetchMessages(token, conversationId, { before: messages[0].id, limit: 50 });
      setHasMore(older.length >= 50);
      setMessages((current) => {
        const seen = new Set(current.map((item) => item.id));
        return [...older.filter((item) => !seen.has(item.id)), ...current];
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load older messages.");
    } finally {
      setLoadingMore(false);
    }
  }

  async function send() {
    if (!token || !conversationId) return;
    const body = draft.trim();
    if (!body) return;
    setBusy(true);
    setError(null);
    try {
      const message = await postMessage(token, conversationId, { body });
      setMessages((current) => (current.some((item) => item.id === message.id) ? current : [...current, message]));
      setDraft("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not send that message.");
    } finally {
      setBusy(false);
    }
  }

  function confirmLeave() {
    if (!token || !conversation || conversation.type !== "group") return;
    Alert.alert("Leave this group?", "You will stop seeing new messages here.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Leave",
        style: "destructive",
        onPress: () => {
          void leaveConversation(token, conversation.id)
            .then(() => router.back())
            .catch((caught) => setError(caught instanceof Error ? caught.message : "Could not leave that group."));
        },
      },
    ]);
  }

  if (session === undefined || loading) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: "Chat" }} />
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  if (!session) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: "Chat" }} />
        <Text style={styles.muted}>Sign in to read this conversation.</Text>
      </View>
    );
  }

  const newestFirst = [...messages].reverse();

  return (
    <KeyboardAvoidingView
      style={styles.page}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={Platform.OS === "ios" ? 88 : 0}
    >
      <Stack.Screen
        options={{
          title,
          headerRight:
            conversation?.type === "group"
              ? () => (
                  <Pressable onPress={confirmLeave} hitSlop={8}>
                    <Ionicons name="exit-outline" size={22} color={colors.text} />
                  </Pressable>
                )
              : undefined,
        }}
      />
      <Notice tone="danger">{error}</Notice>
      {messages.length === 0 && !error ? (
        <View style={styles.empty}>
          <Text style={styles.muted}>No messages yet. Say something — clip sending comes from the player later.</Text>
        </View>
      ) : (
        <FlatList
          inverted
          data={newestFirst}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          onEndReached={() => void loadOlder()}
          onEndReachedThreshold={0.2}
          ListFooterComponent={loadingMore ? <ActivityIndicator color={colors.accent} /> : null}
          renderItem={({ item }) => (
            <Bubble
              message={item}
              mine={item.senderId === userId}
              onClip={(clip) => router.push({ pathname: "/c/[slug]", params: { slug: clip.slug } })}
            />
          )}
        />
      )}
      <View style={[styles.composer, { paddingBottom: Math.max(insets.bottom, 10) }]}>
        <TextInput
          style={styles.input}
          value={draft}
          onChangeText={setDraft}
          placeholder="Message"
          placeholderTextColor={colors.muted}
          maxLength={2000}
          editable={!busy}
          multiline
        />
        <Pressable style={[styles.send, (!draft.trim() || busy) && styles.sendOff]} onPress={() => void send()} disabled={!draft.trim() || busy}>
          {busy ? <ActivityIndicator color="#07080b" /> : <Ionicons name="send" size={16} color="#07080b" />}
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

function Bubble({
  message,
  mine,
  onClip,
}: {
  message: ChatMessage;
  mine: boolean;
  onClip: (clip: MessageClip) => void;
}) {
  return (
    <View style={[styles.bubbleWrap, mine && styles.bubbleMine]}>
      {!mine ? <Avatar name={socialName(message.sender)} uri={message.sender.avatarUrl} size={28} /> : null}
      <View style={[styles.bubble, mine ? styles.mine : styles.theirs]}>
        {!mine ? <Text style={styles.sender}>{socialName(message.sender)}</Text> : null}
        {message.clip ? (
          <Pressable style={styles.clip} onPress={() => onClip(message.clip!)}>
            <ClipThumb title={message.clip.title || "Clip"} thumbnailUrl={message.clip.thumbnailUrl} radius={12} />
            <Text style={[styles.clipTitle, mine && styles.mineText]} numberOfLines={2}>
              {message.clip.title || "Untitled clip"}
            </Text>
            <Text style={[styles.clipMeta, mine && styles.mineMeta]} numberOfLines={1}>
              {message.clip.game?.name || "Clip"}
              {message.clip.durationMs ? ` · ${formatDurationMs(message.clip.durationMs)}` : ""}
            </Text>
          </Pressable>
        ) : null}
        {message.body ? <Text style={[styles.body, mine && styles.mineText]}>{message.body}</Text> : null}
        <Text style={[styles.stamp, mine && styles.mineMeta]}>{formatTimeAgo(message.createdAt)}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, backgroundColor: colors.bg, alignItems: "center", justifyContent: "center", padding: 24 },
  muted: { color: colors.muted, fontSize: 15, lineHeight: 22, textAlign: "center" },
  list: { paddingHorizontal: 12, paddingVertical: 12, gap: 10, flexGrow: 1 },
  empty: { flex: 1, padding: 24, justifyContent: "center" },
  bubbleWrap: { flexDirection: "row", alignItems: "flex-end", gap: 8, maxWidth: "88%" },
  bubbleMine: { alignSelf: "flex-end", flexDirection: "row-reverse" },
  bubble: {
    borderRadius: 18,
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 6,
    maxWidth: "100%",
  },
  mine: { backgroundColor: "#ffffff", alignSelf: "flex-end" },
  theirs: { backgroundColor: colors.raised, alignSelf: "flex-start" },
  sender: { color: colors.accent, fontSize: 12, fontWeight: "700" },
  body: { color: colors.text, fontSize: 16, lineHeight: 22 },
  mineText: { color: "#07080b" },
  stamp: { color: colors.muted, fontSize: 11 },
  mineMeta: { color: "#4a5160" },
  clip: { width: 220, gap: 6 },
  clipTitle: { color: colors.text, fontWeight: "700", fontSize: 14 },
  clipMeta: { color: colors.muted, fontSize: 12 },
  composer: {
    flexDirection: "row",
    gap: 8,
    alignItems: "flex-end",
    paddingHorizontal: 12,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.bg,
  },
  input: {
    flex: 1,
    minHeight: 42,
    maxHeight: 120,
    backgroundColor: colors.raised,
    color: colors.text,
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 16,
  },
  send: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  sendOff: { opacity: 0.4 },
});
