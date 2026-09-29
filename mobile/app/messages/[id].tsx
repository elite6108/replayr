import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Notifications from "expo-notifications";
import { ProfileAvatarLink } from "@/components/ProfileAvatarLink";
import { ClipThumb } from "@/components/ClipThumb";
import { Notice } from "@/components/ui";
import { socialName, type SocialUser } from "@/lib/api.friends";
import {
  conversationPeer,
  conversationTitle,
  fetchConversation,
  fetchMessages,
  leaveConversation,
  mergeThreadMessages,
  postMessage,
  type ChatMessage,
  type ConversationSummary,
  type MessageClip,
} from "@/lib/api.messages";
import { useAuth } from "@/lib/auth";
import { targetFromPushData } from "@/lib/registerStaffPush";
import { useSocialUnread } from "@/lib/socialUnread";
import { formatDurationMs, formatTimeAgo } from "@/lib/format";
import { applyRealtimeAuth, getSupabase, supabaseConfigured } from "@/lib/supabase";
import { colors } from "@/lib/theme";

function firstParam(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

function senderFromConversation(conversation: ConversationSummary | null, userId?: string): SocialUser {
  const me = conversation?.members.find((member) => member.id === userId);
  if (me) return me;
  return {
    id: userId ?? "me",
    username: null,
    displayName: "You",
    avatarUrl: null,
    verified: false,
  };
}

export default function ThreadScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const conversationId = firstParam(params.id);
  const { session } = useAuth();
  const token = session?.access_token;
  const userId = session?.user.id;
  const { setActiveConversation, markConversationRead } = useSocialUnread();
  const headerHeight = useHeaderHeight();
  const insets = useSafeAreaInsets();
  const inputRef = useRef<TextInput>(null);
  const [conversation, setConversation] = useState<ConversationSummary | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [keyboardOpen, setKeyboardOpen] = useState(false);

  const title = conversation ? conversationTitle(conversation, userId) : "Chat";
  const peer = conversation ? conversationPeer(conversation, userId) : null;

  const load = useCallback(async () => {
    if (!token || !conversationId) return;
    setError(null);
    try {
      const [nextConversation, nextMessages] = await Promise.all([
        fetchConversation(token, conversationId),
        fetchMessages(token, conversationId, { limit: 50 }),
      ]);
      setConversation(nextConversation);
      setMessages((current) => mergeThreadMessages(current, nextMessages));
      setHasMore(nextMessages.length >= 50);
      setActiveConversation(conversationId);
      markConversationRead(conversationId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load that chat.");
    } finally {
      setLoading(false);
    }
  }, [token, conversationId, setActiveConversation, markConversationRead]);

  const refreshLive = useCallback(async () => {
    if (!token || !conversationId) return;
    try {
      const [thread, summary] = await Promise.all([
        fetchMessages(token, conversationId, { limit: 50 }),
        fetchConversation(token, conversationId).catch(() => null),
      ]);
      setMessages((current) => mergeThreadMessages(current, thread));
      markConversationRead(conversationId);
      if (summary) {
        setConversation({
          ...summary,
          lastMessage: thread[thread.length - 1] ?? summary.lastMessage,
          unreadCount: 0,
        });
      }
    } catch {
      /* next poll or event retries */
    }
  }, [token, conversationId, markConversationRead]);

  useEffect(() => {
    if (!token) {
      setLoading(false);
      return;
    }
    void load();
    return () => setActiveConversation(null);
  }, [token, load, setActiveConversation]);

  useFocusEffect(
    useCallback(() => {
      if (!token || !conversationId) return;
      const timer = setInterval(() => {
        void refreshLive();
      }, 2000);
      return () => clearInterval(timer);
    }, [token, conversationId, refreshLive]),
  );

  useEffect(() => {
    const show = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow", () => {
      setKeyboardOpen(true);
    });
    const hide = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide", () => {
      setKeyboardOpen(false);
    });
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  useEffect(() => {
    if (!token || !userId || !conversationId || !supabaseConfigured()) return;
    const supabase = getSupabase();
    applyRealtimeAuth(token);
    const onRow = (conversationKey?: string | null) => {
      if (conversationKey === conversationId) void refreshLive();
    };
    const channel = supabase
      .channel(`messages-live:${userId}:${conversationId}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" }, (payload) => {
        const row = payload.new as { conversation_id?: string };
        onRow(row.conversation_id);
      })
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications" }, (payload) => {
        const row = payload.new as { kind?: string; conversation_id?: string | null };
        if (row.kind === "message") onRow(row.conversation_id);
      })
      .subscribe((status) => {
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") void refreshLive();
      });
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [token, userId, conversationId, refreshLive]);

  useEffect(() => {
    if (!conversationId || Platform.OS === "web") return;
    const sub = Notifications.addNotificationReceivedListener((event) => {
      const target = targetFromPushData(event.request.content.data);
      if (target?.kind === "message" && target.conversationId === conversationId) {
        void refreshLive();
      }
    });
    return () => sub.remove();
  }, [conversationId, refreshLive]);

  async function loadOlder() {
    if (!token || !conversationId || loading || loadingMore || !hasMore || messages.length === 0) return;
    const oldest = messages.find((item) => !item.id.startsWith("local:"));
    if (!oldest) return;
    setLoadingMore(true);
    try {
      const older = await fetchMessages(token, conversationId, { before: oldest.id, limit: 50 });
      setHasMore(older.length >= 50);
      setMessages((current) => mergeThreadMessages(current, older));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load older messages.");
    } finally {
      setLoadingMore(false);
    }
  }

  function keepKeyboard() {
    inputRef.current?.focus();
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function send() {
    if (!token || !conversationId || !userId) return;
    const body = draft.trim();
    if (!body) return;
    const localId = `local:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const createdAt = new Date().toISOString();
    const optimistic: ChatMessage = {
      id: localId,
      conversationId,
      senderId: userId,
      body,
      createdAt,
      sender: senderFromConversation(conversation, userId),
      clip: null,
    };
    setError(null);
    setDraft("");
    setMessages((current) => mergeThreadMessages(current, [optimistic]));
    keepKeyboard();
    void postMessage(token, conversationId, { body })
      .then((message) => {
        setMessages((current) =>
          mergeThreadMessages(
            current.filter((item) => item.id !== localId),
            [message],
          ),
        );
      })
      .catch((caught) => {
        setMessages((current) => current.filter((item) => item.id !== localId));
        setDraft(body);
        setError(caught instanceof Error ? caught.message : "Could not send that message.");
        keepKeyboard();
      });
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
        <Stack.Screen options={{ title: "Chat", headerBackTitle: "Back" }} />
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  if (!session) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: "Chat", headerBackTitle: "Back" }} />
        <Text style={styles.muted}>Sign in to read this conversation.</Text>
      </View>
    );
  }

  const newestFirst = [...messages].reverse();

  return (
    <KeyboardAvoidingView
      style={styles.page}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={Platform.OS === "ios" ? headerHeight : 0}
    >
      <Stack.Screen
        options={{
          title,
          headerBackTitle: "Back",
          headerTitle:
            conversation?.type === "dm"
              ? () => (
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                    <ProfileAvatarLink
                      username={peer?.username}
                      name={peer ? socialName(peer) : title}
                      uri={peer?.avatarUrl}
                      size={28}
                    />
                    <Text style={{ color: colors.text, fontWeight: "700", fontSize: 16 }}>{title}</Text>
                  </View>
                )
              : undefined,
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
        <Pressable style={styles.empty} onPress={Keyboard.dismiss}>
          <Text style={styles.muted}>No messages yet. Say something — clip sending comes from the player later.</Text>
        </Pressable>
      ) : (
        <FlatList
          inverted
          data={newestFirst}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          keyboardShouldPersistTaps="always"
          keyboardDismissMode="interactive"
          onEndReached={() => void loadOlder()}
          onEndReachedThreshold={0.2}
          ListFooterComponent={loadingMore ? <ActivityIndicator color={colors.accent} /> : null}
          ListHeaderComponent={<Pressable style={styles.listDismiss} onPress={Keyboard.dismiss} />}
          renderItem={({ item }) => (
            <Bubble
              message={item}
              mine={item.senderId === userId}
              onClip={(clip) => router.push({ pathname: "/c/[slug]", params: { slug: clip.slug } })}
            />
          )}
        />
      )}
      <View style={[styles.composer, { paddingBottom: keyboardOpen ? 10 : Math.max(insets.bottom, 10) }]}>
        <TextInput
          ref={inputRef}
          style={styles.input}
          value={draft}
          onChangeText={setDraft}
          placeholder="Message"
          placeholderTextColor={colors.muted}
          maxLength={2000}
          multiline
          blurOnSubmit={false}
        />
        <Pressable
          style={[styles.send, !draft.trim() && styles.sendOff]}
          onPress={() => {
            send();
            keepKeyboard();
          }}
          disabled={!draft.trim()}
        >
          <Ionicons name="send" size={16} color={colors.onAccent} />
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
      {!mine ? (
        <ProfileAvatarLink
          username={message.sender.username}
          name={socialName(message.sender)}
          uri={message.sender.avatarUrl}
          size={28}
        />
      ) : null}
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
  listDismiss: { minHeight: 16 },
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
