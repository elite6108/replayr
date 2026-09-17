import { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth } from "@/lib/auth";
import { readApiJson } from "@/lib/http";
import { apiUrl } from "@/lib/supabase";
import { colors } from "@/lib/theme";

type Task = {
  id: string;
  boardId: string;
  title: string;
  priority: string;
  dueAt: string | null;
};

export default function StaffTasksScreen() {
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const [tasks, setTasks] = useState<Task[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const me = await fetch(apiUrl("/v1/staff/me"), { headers: { authorization: `Bearer ${token}` } });
      if (me.status === 403) {
        setDenied(true);
        return;
      }
      const suffix = query.trim() ? `?filter=assigned&q=${encodeURIComponent(query.trim())}` : "?filter=assigned";
      const body = await readApiJson<{ tasks: Task[] }>(
        await fetch(apiUrl(`/v1/staff/tasks${suffix}`), { headers: { authorization: `Bearer ${token}` } }),
        "Could not load tasks.",
      );
      setTasks(body.tasks);
      setError(null);
      setDenied(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load tasks.");
    }
  }, [token, query]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <Text style={styles.title}>My tasks</Text>
      {denied ? (
        <Text style={styles.muted}>Access denied. Staff membership is required.</Text>
      ) : (
        <>
          <TextInput
            style={styles.search}
            placeholder="Search assigned tasks"
            placeholderTextColor={colors.muted}
            value={query}
            onChangeText={setQuery}
            onSubmitEditing={() => void load()}
          />
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <ScrollView contentContainerStyle={styles.list}>
            {tasks.map((task) => (
              <Pressable key={task.id} style={styles.card}>
                <Text style={styles.cardTitle}>{task.title}</Text>
                <Text style={styles.muted}>
                  {task.priority}
                  {task.dueAt ? ` · due ${new Date(task.dueAt).toLocaleDateString()}` : ""}
                </Text>
              </Pressable>
            ))}
            {tasks.length === 0 ? <Text style={styles.muted}>No assigned tasks.</Text> : null}
          </ScrollView>
        </>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg, paddingHorizontal: 16 },
  title: { color: colors.text, fontSize: 28, fontWeight: "800", marginBottom: 12 },
  search: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    color: colors.text,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 12,
  },
  list: { gap: 10, paddingBottom: 40 },
  card: { padding: 14, borderRadius: 14, backgroundColor: colors.raised, borderWidth: 1, borderColor: colors.border },
  cardTitle: { color: colors.text, fontSize: 16, fontWeight: "700" },
  muted: { color: colors.muted, marginTop: 4 },
  error: { color: "#f08a8a", marginBottom: 8 },
});
