import { useState } from "react";
import { ActivityIndicator, Alert, Modal, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { blockUser } from "@/lib/api.friends";
import {
  REPORT_REASON_LABELS,
  REPORT_REASONS,
  reportContent,
  type ReportReason,
  type ReportTargetType,
} from "@/lib/api.safety";
import { useAuth } from "@/lib/auth";
import { colors } from "@/lib/theme";

export function ReportContentSheet({
  targetType,
  targetId,
  subjectUserId,
  onClose,
  onBlocked,
}: {
  targetType: ReportTargetType;
  targetId: string;
  subjectUserId?: string | null;
  onClose: () => void;
  onBlocked?: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { session } = useAuth();
  const token = session?.access_token;
  const [reason, setReason] = useState<ReportReason>("harassment");
  const [details, setDetails] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const result = await reportContent(token, { targetType, targetId, reason, details });
      setDone(
        result.alreadyReported
          ? "You already reported this. We'll still review it within 24 hours."
          : "Thanks. We'll review this within 24 hours.",
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not send that report.");
    } finally {
      setBusy(false);
    }
  }

  function block() {
    if (!token || !subjectUserId) return;
    Alert.alert("Block this account?", "They will not be able to comment on your clips or message you.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Block",
        style: "destructive",
        onPress: () => {
          setBusy(true);
          void blockUser(token, subjectUserId)
            .then(() => {
              onBlocked?.();
              onClose();
            })
            .catch((caught: unknown) => {
              setError(caught instanceof Error ? caught.message : "Could not block that account.");
              setBusy(false);
            });
        },
      },
    ]);
  }

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]}>
        <Text style={styles.title}>Report</Text>
        {done ? (
          <>
            <Text style={styles.body}>{done}</Text>
            {error ? <Text style={styles.error}>{error}</Text> : null}
            {subjectUserId ? (
              <Pressable style={styles.danger} onPress={block} disabled={busy}>
                <Text style={styles.dangerLabel}>Block this account</Text>
              </Pressable>
            ) : null}
            <Pressable style={styles.secondary} onPress={onClose}>
              <Text style={styles.secondaryLabel}>Done</Text>
            </Pressable>
          </>
        ) : (
          <>
            <Text style={styles.muted}>Reports are reviewed within 24 hours. The person is not told who reported them.</Text>
            {REPORT_REASONS.map((item) => (
              <Pressable key={item} style={styles.reason} onPress={() => setReason(item)}>
                <Text style={[styles.reasonLabel, reason === item && styles.reasonOn]}>{REPORT_REASON_LABELS[item]}</Text>
              </Pressable>
            ))}
            <TextInput
              style={styles.input}
              value={details}
              onChangeText={setDetails}
              maxLength={500}
              placeholder="Optional details. Only moderators see this."
              placeholderTextColor={colors.muted}
              multiline
            />
            {error ? <Text style={styles.error}>{error}</Text> : null}
            <Pressable style={styles.primary} onPress={() => void submit()} disabled={busy || !token}>
              {busy ? <ActivityIndicator color={colors.onAccent} /> : <Text style={styles.primaryLabel}>Send report</Text>}
            </Pressable>
          </>
        )}
      </View>
    </Modal>
  );
}

export function confirmBlockAccount(token: string, userId: string, onBlocked?: () => void) {
  Alert.alert("Block this account?", "They will not be able to comment on your clips or message you.", [
    { text: "Cancel", style: "cancel" },
    {
      text: "Block",
      style: "destructive",
      onPress: () => {
        void blockUser(token, userId)
          .then(() => onBlocked?.())
          .catch((caught: unknown) => {
            Alert.alert("Could not block", caught instanceof Error ? caught.message : "Try again.");
          });
      },
    },
  ]);
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "#00000066" },
  sheet: {
    backgroundColor: colors.bg,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    padding: 16,
    gap: 8,
    maxHeight: "80%",
  },
  title: { color: colors.text, fontSize: 18, fontWeight: "700" },
  body: { color: colors.text, fontSize: 15, lineHeight: 22 },
  muted: { color: colors.muted, fontSize: 13, lineHeight: 18 },
  error: { color: "#ff6b6b", fontSize: 13 },
  reason: { paddingVertical: 6 },
  reasonLabel: { color: colors.text, fontSize: 16 },
  reasonOn: { color: colors.accent, fontWeight: "700" },
  input: {
    minHeight: 72,
    borderRadius: 12,
    backgroundColor: colors.raised,
    color: colors.text,
    padding: 12,
    textAlignVertical: "top",
  },
  primary: {
    backgroundColor: colors.accent,
    borderRadius: 12,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryLabel: { color: colors.onAccent, fontWeight: "700" },
  secondary: { minHeight: 44, alignItems: "center", justifyContent: "center" },
  secondaryLabel: { color: colors.text, fontWeight: "600" },
  danger: { minHeight: 44, alignItems: "center", justifyContent: "center" },
  dangerLabel: { color: "#ff6b6b", fontWeight: "700" },
});
