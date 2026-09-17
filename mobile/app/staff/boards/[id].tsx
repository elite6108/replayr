import { useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { AppHeader } from "@/components/AppHeader";
import { StaffBoardPicker } from "@/components/staff/StaffBoardPicker";
import { StaffBoardMembersSheet } from "@/components/staff/StaffBoardMembersSheet";
import { StaffCreateTaskSheet } from "@/components/staff/StaffCreateTaskSheet";
import { StaffDeleteBoardSheet } from "@/components/staff/StaffDeleteBoardSheet";
import { StaffFilterSheet } from "@/components/staff/StaffFilterSheet";
import { StaffAccessDenied } from "@/components/staff/StaffAccessDenied";
import { StaffGate } from "@/components/staff/StaffGate";
import { StaffLanePills } from "@/components/staff/StaffLanePills";
import { StaffSortSheet } from "@/components/staff/StaffSortSheet";
import { StaffTaskCard } from "@/components/staff/StaffTaskCard";
import { staffStyles } from "@/components/staff/staffStyles";
import { useStaffPoll } from "@/components/staff/useStaffPoll";
import { Notice } from "@/components/ui";
import {
  fetchStaffBoard,
  fetchStaffBoards,
  isStaffForbidden,
  staffBoardHref,
  staffBoardsHref,
  staffTaskHref,
  type StaffBoardDetail,
  type StaffBoardSummary,
} from "@/lib/api.staff";
import { useAuth } from "@/lib/auth";
import { useStaffPermissions } from "@/lib/staffPermissions";
import {
  EMPTY_BOARD_FILTERS,
  activeFilterCount,
  boardSubtitle,
  sortTasks,
  taskMatchesFilters,
} from "@/lib/staffUi";
import { colors } from "@/lib/theme";

export default function StaffBoardScreen() {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const id = (Array.isArray(params.id) ? params.id[0] : params.id)?.trim() ?? "";
  const router = useRouter();
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const { can } = useStaffPermissions();
  const [board, setBoard] = useState<StaffBoardDetail | null>(null);
  const [boards, setBoards] = useState<StaffBoardSummary[]>([]);
  const [laneId, setLaneId] = useState("");
  const [filters, setFilters] = useState(EMPTY_BOARD_FILTERS);
  const [sort, setSort] = useState("rank");
  const [error, setError] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const load = useCallback(async () => {
    if (!token || !id) return;
    try {
      const [detail, list] = await Promise.all([fetchStaffBoard(token, id), fetchStaffBoards(token)]);
      setBoard(detail.board);
      setBoards(list.boards);
      setLaneId((current) => {
        if (current && detail.board.columns.some((column) => column.id === current)) return current;
        return detail.board.columns[0]?.id ?? "";
      });
      setError(null);
      setDenied(false);
    } catch (caught) {
      if (isStaffForbidden(caught)) {
        setDenied(true);
        return;
      }
      setError(caught instanceof Error ? caught.message : "Could not load that board.");
    }
  }, [id, token]);

  useStaffPoll(load);

  const lane = board?.columns.find((column) => column.id === laneId) ?? board?.columns[0] ?? null;
  const cards = useMemo(() => {
    if (!board || !lane) return [];
    const filtered = lane.tasks.filter((task) => taskMatchesFilters(task, filters, board.labels));
    return sortTasks(filtered, sort);
  }, [board, lane, filters, sort]);
  const filterCount = activeFilterCount(filters);
  const canCreate = Boolean(board?.canMutate && can("board.cards.create"));

  if (denied) {
    return (
      <StaffGate permission="board.view">
        <StaffAccessDenied message="Access denied. You do not have permission to open this board." />
      </StaffGate>
    );
  }

  return (
    <StaffGate permission="board.view">
        <SafeAreaView style={staffStyles.page} edges={["top"]}>
          <AppHeader padded />
          <ScrollView contentContainerStyle={staffStyles.scroll}>
            <Pressable onPress={() => router.replace(staffBoardsHref())}>
              <Text style={staffStyles.back}>Boards</Text>
            </Pressable>
            <View style={staffStyles.titleRow}>
              <View style={{ flex: 1, gap: 4 }}>
                <Text style={staffStyles.eyebrow}>Operations</Text>
                <Pressable onPress={() => setPickerOpen(true)}>
                  <Text style={staffStyles.title}>{board?.name ?? "Board"}</Text>
                </Pressable>
                <Text style={staffStyles.subtitle}>{boardSubtitle(board)}</Text>
              </View>
              <View style={staffStyles.row}>
                <Pressable
                  style={[staffStyles.iconBtn, filterCount > 0 && staffStyles.iconBtnOn]}
                  onPress={() => setFilterOpen(true)}
                  accessibilityLabel="Filter"
                >
                  <Ionicons name="filter" size={18} color={colors.text} />
                  {filterCount > 0 ? (
                    <View style={staffStyles.badge}>
                      <Text style={staffStyles.badgeText}>{filterCount}</Text>
                    </View>
                  ) : null}
                </Pressable>
                <Pressable style={staffStyles.iconBtn} onPress={() => setSortOpen(true)} accessibilityLabel="Sort">
                  <Ionicons name="swap-vertical" size={18} color={colors.text} />
                </Pressable>
                {board?.canManageMembers ? (
                  <Pressable
                    style={staffStyles.iconBtn}
                    onPress={() => setMembersOpen(true)}
                    accessibilityLabel="Manage board members"
                  >
                    <Ionicons name="people-outline" size={19} color={colors.text} />
                  </Pressable>
                ) : (
                  <Pressable
                    style={staffStyles.iconBtn}
                    onPress={() => setMembersOpen(true)}
                    accessibilityLabel="Board email notifications"
                  >
                    <Ionicons name="mail-outline" size={18} color={colors.text} />
                  </Pressable>
                )}
                {board?.canDelete ? (
                  <Pressable
                    style={staffStyles.iconBtn}
                    onPress={() => setDeleteOpen(true)}
                    accessibilityLabel="Permanently delete board"
                  >
                    <Ionicons name="trash-outline" size={18} color={colors.danger} />
                  </Pressable>
                ) : null}
                {canCreate ? (
                  <Pressable style={staffStyles.iconBtn} onPress={() => setCreateOpen(true)} accessibilityLabel="Create task">
                    <Ionicons name="add" size={20} color={colors.text} />
                  </Pressable>
                ) : null}
              </View>
            </View>
            {error ? <Notice tone="danger">{error}</Notice> : null}
            {board ? (
              <StaffLanePills columns={board.columns} activeId={lane?.id ?? ""} onSelect={setLaneId} />
            ) : (
              <View style={staffStyles.skeleton} />
            )}
            {cards.map((task) => (
              <StaffTaskCard
                key={task.id}
                task={task}
                labels={board?.labels}
                onPress={() => router.push(staffTaskHref(task.id))}
              />
            ))}
            {board && cards.length === 0 ? <Text style={staffStyles.muted}>No tasks in this lane.</Text> : null}
            {!board && !error ? (
              <>
                <View style={staffStyles.skeleton} />
                <View style={staffStyles.skeleton} />
              </>
            ) : null}
          </ScrollView>
          <StaffBoardPicker
            visible={pickerOpen}
            boards={boards}
            activeId={board?.id}
            onClose={() => setPickerOpen(false)}
            onSelect={(next) => router.replace(staffBoardHref(next))}
          />
          <StaffFilterSheet
            visible={filterOpen}
            filters={filters}
            people={board?.people ?? []}
            labels={board?.labels ?? []}
            onChange={setFilters}
            onClose={() => setFilterOpen(false)}
          />
          <StaffSortSheet visible={sortOpen} value={sort} onChange={setSort} onClose={() => setSortOpen(false)} />
          <StaffCreateTaskSheet
            visible={createOpen}
            token={token}
            boards={boards}
            board={board}
            defaultColumnId={lane?.id}
            onClose={() => setCreateOpen(false)}
            onCreated={(taskId) => {
              void load();
              router.push(staffTaskHref(taskId));
            }}
          />
          {board ? (
            <StaffBoardMembersSheet
              visible={membersOpen}
              token={token}
              boardId={board.id}
              canManageMembers={Boolean(board.canManageMembers)}
              emailEnabled={board.emailEnabled !== false}
              onClose={() => setMembersOpen(false)}
              onChanged={() => void load()}
              onEmailChanged={(enabled) => setBoard((current) => (current ? { ...current, emailEnabled: enabled } : current))}
            />
          ) : null}
          {board?.canDelete ? (
            <StaffDeleteBoardSheet
              visible={deleteOpen}
              token={token}
              boardId={board.id}
              boardName={board.name}
              onClose={() => setDeleteOpen(false)}
              onDeleted={() => router.replace(staffBoardsHref())}
            />
          ) : null}
        </SafeAreaView>
    </StaffGate>
  );
}
