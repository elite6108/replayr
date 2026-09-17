import { useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { AppHeader } from "@/components/AppHeader";
import { FolderSheetFrame } from "@/components/folders/FolderSheetFrame";
import { StaffGate } from "@/components/staff/StaffGate";
import { StaffTaskCard } from "@/components/staff/StaffTaskCard";
import { staffStyles } from "@/components/staff/staffStyles";
import { useStaffPoll } from "@/components/staff/useStaffPoll";
import { Button, Notice } from "@/components/ui";
import { fetchMyStaffTasks, staffHref, staffTaskHref, type StaffMyTask } from "@/lib/api.staff";
import { useAuth } from "@/lib/auth";
import { MY_TASK_GROUPS, PRIORITIES, groupMyTasks } from "@/lib/staffUi";
import { colors } from "@/lib/theme";

export default function StaffMyTasksScreen() {
  const router = useRouter();
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const [tasks, setTasks] = useState<StaffMyTask[]>([]);
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [filter, setFilter] = useState("assigned");
  const [priority, setPriority] = useState("");
  const [due, setDue] = useState("");
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const body = await fetchMyStaffTasks(token, {
        filter,
        q: submitted || undefined,
        priority: priority || undefined,
        due: due || undefined,
        page: 1,
        limit: 30,
      });
      setTasks(body.tasks);
      setPage(1);
      setHasMore(body.tasks.length >= body.limit);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load tasks.");
    }
  }, [token, filter, submitted, priority, due]);

  useStaffPoll(load);

  async function loadMore() {
    if (!token || !hasMore) return;
    const nextPage = page + 1;
    try {
      const body = await fetchMyStaffTasks(token, {
        filter,
        q: submitted || undefined,
        priority: priority || undefined,
        due: due || undefined,
        page: nextPage,
        limit: 30,
      });
      setTasks((current) => [...current, ...body.tasks]);
      setPage(nextPage);
      setHasMore(body.tasks.length >= body.limit);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load more tasks.");
    }
  }

  const groups = useMemo(() => groupMyTasks(tasks), [tasks]);
  const filterCount = [filter !== "assigned", priority, due].filter(Boolean).length;

  return (
    <StaffGate permission="board.view">
      <SafeAreaView style={staffStyles.page} edges={["top"]}>
        <AppHeader padded />
        <ScrollView contentContainerStyle={staffStyles.scroll}>
          <Pressable onPress={() => router.replace(staffHref())}>
            <Text style={staffStyles.back}>Staff Tools</Text>
          </Pressable>
          <View style={staffStyles.titleRow}>
            <View style={{ flex: 1, gap: 4 }}>
              <Text style={staffStyles.eyebrow}>Operations</Text>
              <Text style={staffStyles.title}>My Tasks</Text>
              <Text style={staffStyles.subtitle}>Assigned, watching, or created by you.</Text>
            </View>
            <Pressable
              style={[staffStyles.iconBtn, filterCount > 0 && staffStyles.iconBtnOn]}
              onPress={() => setFilterOpen(true)}
              accessibilityLabel="Filter tasks"
            >
              <Ionicons name="filter" size={18} color={colors.text} />
              {filterCount > 0 ? (
                <View style={staffStyles.badge}>
                  <Text style={staffStyles.badgeText}>{filterCount}</Text>
                </View>
              ) : null}
            </Pressable>
          </View>
          <TextInput
            style={staffStyles.input}
            placeholder="Search assigned tasks"
            placeholderTextColor={colors.muted}
            value={query}
            onChangeText={setQuery}
            onSubmitEditing={() => setSubmitted(query.trim())}
            returnKeyType="search"
          />
          {error ? <Notice tone="danger">{error}</Notice> : null}
          {MY_TASK_GROUPS.map((label) => {
            const rows = groups[label];
            if (!rows.length) return null;
            return (
              <View key={label} style={{ gap: 8 }}>
                <Text style={staffStyles.section}>{label}</Text>
                {rows.map((task) => (
                  <StaffTaskCard key={task.id} task={task} onPress={() => router.push(staffTaskHref(task.id))} />
                ))}
              </View>
            );
          })}
          {tasks.length === 0 && !error ? <Text style={staffStyles.muted}>No tasks here yet.</Text> : null}
          {hasMore ? <Button label="Load more" onPress={() => void loadMore()} /> : null}
        </ScrollView>
        <FolderSheetFrame
          visible={filterOpen}
          title="Filter"
          onClose={() => setFilterOpen(false)}
          footer={
            <Button
              label="Reset"
              onPress={() => {
                setFilter("assigned");
                setPriority("");
                setDue("");
              }}
            />
          }
        >
          <Text style={staffStyles.section}>List</Text>
          <View style={staffStyles.row}>
            {[
              ["assigned", "Assigned"],
              ["watching", "Watching"],
              ["created", "Created"],
            ].map(([value, label]) => (
              <Pressable
                key={value}
                style={[staffStyles.pill, filter === value && staffStyles.pillOn]}
                onPress={() => setFilter(value)}
              >
                <Text style={[staffStyles.pillText, filter === value && staffStyles.pillTextOn]}>{label}</Text>
              </Pressable>
            ))}
          </View>
          <Text style={staffStyles.section}>Priority</Text>
          <View style={staffStyles.row}>
            {["", ...PRIORITIES.filter((item) => item !== "none")].map((value) => (
              <Pressable
                key={value || "any"}
                style={[staffStyles.pill, priority === value && staffStyles.pillOn]}
                onPress={() => setPriority(value)}
              >
                <Text style={[staffStyles.pillText, priority === value && staffStyles.pillTextOn]}>{value || "Any"}</Text>
              </Pressable>
            ))}
          </View>
          <Text style={staffStyles.section}>Due</Text>
          <View style={staffStyles.row}>
            <Pressable style={[staffStyles.pill, !due && staffStyles.pillOn]} onPress={() => setDue("")}>
              <Text style={[staffStyles.pillText, !due && staffStyles.pillTextOn]}>Any</Text>
            </Pressable>
            <Pressable style={[staffStyles.pill, due === "overdue" && staffStyles.pillOn]} onPress={() => setDue("overdue")}>
              <Text style={[staffStyles.pillText, due === "overdue" && staffStyles.pillTextOn]}>Overdue</Text>
            </Pressable>
          </View>
        </FolderSheetFrame>
      </SafeAreaView>
    </StaffGate>
  );
}
