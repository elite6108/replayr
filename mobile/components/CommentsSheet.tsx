import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Avatar } from "@/components/Avatar";
import {
  deleteClipComment,
  fetchClipComments,
  postClipComment,
  type ClipComment,
} from "@/lib/api";
import { formatHandle } from "@/lib/format";
import { colors } from "@/lib/theme";

export function CommentsSheet({
  slug,
  visible,
  token,
  onClose,
  onCount,
}: {
  slug: string;
  visible: boolean;
  token?: string | null;
  onClose: () => void;
  onCount?: (count: number) => void;
}) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [comments, setComments] = useState<ClipComment[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!visible || !slug) return;
    let cancelled = false;
    setError(null);
    void fetchClipComments(slug, token)
      .then((next) => {
        if (!cancelled) setComments(next);
      })
      .catch((caught) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Could not load comments.");
      });
    return () => {
      cancelled = true;
    };
  }, [visible, slug, token]);

  async function submit() {
    if (!token) {
      onClose();
      router.push("/signin");
      return;
    }
    const body = draft.trim();
    if (!body) return;
    setBusy(true);
    setError(null);
    try {
      const next = await postClipComment(slug, body, token);
      setComments(next.comments);
      setDraft("");
      onCount?.(next.commentCount);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not post that comment.");
    } finally {
      setBusy(false);
    }
  }

  function remove(comment: ClipComment) {
    if (!token) return;
    Alert.alert("Delete comment?", undefined, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          void deleteClipComment(slug, comment.id, token)
            .then((next) => {
              setComments((current) => current.filter((item) => item.id !== comment.id));
              onCount?.(next.commentCount);
            })
            .catch((caught) => setError(caught instanceof Error ? caught.message : "Could not delete that comment."));
        },
      },
    ]);
  }

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.wrap} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <Pressable style={styles.backdrop} onPress={onClose} />
        <View style={[styles.sheet, { paddingBottom: insets.bottom + 12 }]}>
          <View style={styles.grip} />
          <View style={styles.head}>
            <Text style={styles.title}>Comments</Text>
            <Pressable onPress={onClose} hitSlop={12}>
              <Ionicons name="close" size={22} color={colors.text} />
            </Pressable>
          </View>
          <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
            {error ? <Text style={styles.error}>{error}</Text> : null}
            {comments.length === 0 && !error ? <Text style={styles.muted}>Be the first to comment.</Text> : null}
            {comments.map((comment) => (
              <View key={comment.id} style={styles.row}>
                <Avatar name={comment.author.displayName || comment.author.username} uri={comment.author.avatarUrl} size={28} />
                <View style={styles.body}>
                  <Text style={styles.author}>{formatHandle(comment.author)}</Text>
                  <Text style={styles.text}>{comment.body}</Text>
                </View>
                {comment.canDelete ? (
                  <Pressable onPress={() => remove(comment)} hitSlop={8}>
                    <Ionicons name="trash-outline" size={16} color={colors.muted} />
                  </Pressable>
                ) : null}
              </View>
            ))}
          </ScrollView>
          <View style={styles.composer}>
            <TextInput
              style={styles.input}
              value={draft}
              onChangeText={setDraft}
              placeholder={token ? "Add a comment" : "Sign in to comment"}
              placeholderTextColor={colors.muted}
              maxLength={500}
              editable={!busy}
            />
            <Pressable style={styles.send} onPress={() => void submit()} disabled={busy}>
              {busy ? <ActivityIndicator color="#000" /> : <Ionicons name="send" size={16} color="#000" />}
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, justifyContent: "flex-end" },
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: "#00000088" },
  sheet: {
    backgroundColor: "#12141a",
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: "78%",
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  grip: { alignSelf: "center", width: 36, height: 4, borderRadius: 2, backgroundColor: "#333", marginBottom: 10 },
  head: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  title: { color: colors.text, fontSize: 18, fontWeight: "700" },
  list: { minHeight: 160 },
  listContent: { gap: 14, paddingBottom: 16 },
  row: { flexDirection: "row", gap: 10, alignItems: "flex-start" },
  body: { flex: 1, gap: 2 },
  author: { color: colors.text, fontWeight: "700", fontSize: 13 },
  text: { color: colors.text, fontSize: 14, lineHeight: 20 },
  muted: { color: colors.muted, fontSize: 14 },
  error: { color: colors.danger, fontSize: 13 },
  composer: { flexDirection: "row", gap: 8, alignItems: "center", paddingTop: 8 },
  input: {
    flex: 1,
    backgroundColor: "#0b0c0f",
    color: colors.text,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: colors.border,
  },
  send: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
});
