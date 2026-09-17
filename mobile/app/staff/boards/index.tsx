import { useCallback, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { AppHeader } from "@/components/AppHeader";
import { StaffGate } from "@/components/staff/StaffGate";
import { StaffCreateBoardSheet } from "@/components/staff/StaffCreateBoardSheet";
import { staffStyles } from "@/components/staff/staffStyles";
import { Notice } from "@/components/ui";
import { fetchStaffBoards, staffBoardHref, staffHref, type StaffBoardSummary } from "@/lib/api.staff";
import { useAuth } from "@/lib/auth";
import { useStaffPermissions } from "@/lib/staffPermissions";
import { useStaffPoll } from "@/components/staff/useStaffPoll";
import { visibilityLabel } from "@/lib/staffUi";
import { colors } from "@/lib/theme";

export default function StaffBoardsScreen() {
  const router = useRouter();
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const { can } = useStaffPermissions();
  const [boards, setBoards] = useState<StaffBoardSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const body = await fetchStaffBoards(token);
      setBoards(body.boards);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load boards.");
    }
  }, [token]);

  useStaffPoll(load);

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
              <Text style={staffStyles.title}>Task Boards</Text>
            </View>
            {can("board.create") ? (
              <Pressable
                style={staffStyles.iconBtn}
                onPress={() => setCreateOpen(true)}
                accessibilityLabel="Create private board"
              >
                <Ionicons name="add" size={21} color={colors.text} />
              </Pressable>
            ) : null}
          </View>
          <Text style={staffStyles.subtitle}>Open a board to work a single lane at a time.</Text>
          {error ? <Notice tone="danger">{error}</Notice> : null}
          {boards.map((board) => (
            <Pressable key={board.id} style={staffStyles.card} onPress={() => router.push(staffBoardHref(board.id))}>
              <Text style={staffStyles.cardTitle}>{board.name}</Text>
              <Text style={staffStyles.muted}>
                {visibilityLabel(board.visibility)}
                {board.description ? ` · ${board.description}` : ""}
              </Text>
            </Pressable>
          ))}
          {boards.length === 0 && !error ? <Text style={staffStyles.muted}>No boards yet.</Text> : null}
        </ScrollView>
        <StaffCreateBoardSheet
          visible={createOpen}
          token={token}
          onClose={() => setCreateOpen(false)}
          onCreated={(boardId) => router.push(staffBoardHref(boardId))}
        />
      </SafeAreaView>
    </StaffGate>
  );
}
