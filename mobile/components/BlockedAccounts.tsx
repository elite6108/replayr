import { useCallback, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { fetchBlockedAccounts, unblockUser, type BlockedAccount } from "@/lib/api.safety";
import { colors } from "@/lib/theme";

export function BlockedAccounts({ token }: { token?: string }) {
  const [users, setUsers] = useState<BlockedAccount[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!token) return;
    void fetchBlockedAccounts(token)
      .then(setUsers)
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Could not load blocked accounts."));
  }, [token]);

  useFocusEffect(load);

  if (!token) return null;

  function unblock(userId: string) {
    if (!token) return;
    setBusyId(userId);
    setError(null);
    void unblockUser(token, userId)
      .then(() => setUsers((current) => (current ?? []).filter((user) => user.id !== userId)))
      .catch((caught: unknown) => {
        Alert.alert("Could not unblock", caught instanceof Error ? caught.message : "Try again.");
      })
      .finally(() => setBusyId(null));
  }

  return (
    <View style={styles.card}>
      <Text style={styles.title}>Blocked accounts</Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {users == null ? (
        <Text style={styles.muted}>Loading…</Text>
      ) : users.length === 0 ? (
        <Text style={styles.muted}>You have not blocked anyone.</Text>
      ) : (
        users.map((user) => (
          <View key={user.id} style={styles.row}>
            <Text style={styles.name}>
              {user.displayName}
              {user.username ? ` @${user.username}` : ""}
            </Text>
            <Pressable onPress={() => unblock(user.id)} disabled={busyId === user.id}>
              <Text style={styles.action}>{busyId === user.id ? "…" : "Unblock"}</Text>
            </Pressable>
          </View>
        ))
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.raised, borderRadius: 16, padding: 16, gap: 10 },
  title: { color: colors.text, fontWeight: "700", fontSize: 16 },
  muted: { color: colors.muted, fontSize: 14 },
  error: { color: "#ff6b6b", fontSize: 13 },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  name: { color: colors.text, flex: 1 },
  action: { color: colors.accent, fontWeight: "700" },
});
