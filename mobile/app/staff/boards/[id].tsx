import { useCallback, useState } from "react";
import { Alert, Pressable, Text, TextInput, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { AppHeader } from "@/components/AppHeader";
import { FolderSheetFrame } from "@/components/folders/FolderSheetFrame";
import { StaffBoardPicker } from "@/components/staff/StaffBoardPicker";
import { StaffBoardMembersSheet } from "@/components/staff/StaffBoardMembersSheet";
import { StaffCreateTaskSheet } from "@/components/staff/StaffCreateTaskSheet";
import { StaffDeleteBoardSheet } from "@/components/staff/StaffDeleteBoardSheet";
import { StaffFilterSheet } from "@/components/staff/StaffFilterSheet";
import { StaffAccessDenied } from "@/components/staff/StaffAccessDenied";
import { StaffGate } from "@/components/staff/StaffGate";
import { StaffKanban } from "@/components/staff/StaffKanban";
import { StaffSortSheet } from "@/components/staff/StaffSortSheet";
import { staffStyles } from "@/components/staff/staffStyles";
import { useStaffPoll } from "@/components/staff/useStaffPoll";
import { Button, Notice } from "@/components/ui";
import {
  archiveStaffTask,
  fetchStaffBoard,
  fetchStaffBoards,
  isStaffForbidden,
  moveStaffTask,
  patchStaffTask,
  staffBoardHref,
  staffBoardsHref,
  staffTaskHref,
  type StaffBoardCard,
  type StaffBoardDetail,
  type StaffBoardSummary,
} from "@/lib/api.staff";
import { useAuth } from "@/lib/auth";
import { useStaffPermissions } from "@/lib/staffPermissions";
import { EMPTY_BOARD_FILTERS, activeFilterCount, boardSubtitle } from "@/lib/staffUi";
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
  const [filters, setFilters] = useState(EMPTY_BOARD_FILTERS);
  const [sort, setSort] = useState("rank");
  const [error, setError] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createColumnId, setCreateColumnId] = useState<string | undefined>();
  const [membersOpen, setMembersOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [renameCard, setRenameCard] = useState<StaffBoardCard | null>(null);
  const [renameTitle, setRenameTitle] = useState("");

  const load = useCallback(async () => {
    if (!token || !id) return;
    try {
      const [detail, list] = await Promise.all([fetchStaffBoard(token, id), fetchStaffBoards(token)]);
      setBoard(detail.board);
      setBoards(list.boards);
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

  const filterCount = activeFilterCount(filters);
  const canCreate = Boolean(board?.canMutate && can("board.cards.create"));
  const canRenameCards = Boolean(board?.canMutate && can("board.cards.edit"));
  const canDeleteCards = Boolean(board?.canMutate && can("board.cards.delete"));
  const canMove = Boolean(board?.canMutate && can("board.cards.move"));

  function removeCard(taskId: string) {
    setBoard((current) =>
      current
        ? {
            ...current,
            columns: current.columns.map((column) => ({
              ...column,
              tasks: column.tasks.filter((task) => task.id !== taskId),
            })),
          }
        : current,
    );
  }

  function moveCard(task: StaffBoardCard, columnId: string) {
    if (!token || !board) return;
    const target = board.columns.find((column) => column.id === columnId);
    const last = target?.tasks.filter((item) => item.id !== task.id).at(-1);
    setBoard((current) => {
      if (!current) return current;
      let moving: StaffBoardCard | null = null;
      const stripped = current.columns.map((column) => {
        const found = column.tasks.find((item) => item.id === task.id);
        if (found) moving = found;
        return { ...column, tasks: column.tasks.filter((item) => item.id !== task.id) };
      });
      if (!moving) return current;
      return {
        ...current,
        columns: stripped.map((column) =>
          column.id === columnId ? { ...column, tasks: [...column.tasks, moving!] } : column,
        ),
      };
    });
    void moveStaffTask(token, task.id, { columnId, afterRank: last?.rank ?? null, beforeRank: null }).catch(
      (caught: unknown) => {
        setError(caught instanceof Error ? caught.message : "Could not move card.");
        void load();
      },
    );
  }

  function openCardMenu(task: StaffBoardCard) {
    const columns = board?.columns.filter((column) => !column.tasks.some((item) => item.id === task.id)) ?? [];
    if (!canRenameCards && !canDeleteCards && !canMove) return;
    Alert.alert(task.title, undefined, [
      ...(canRenameCards
        ? [
            {
              text: "Rename",
              onPress: () => {
                setRenameCard(task);
                setRenameTitle(task.title);
              },
            },
          ]
        : []),
      ...(canMove && columns.length
        ? [
            {
              text: "Move to…",
              onPress: () =>
                Alert.alert(
                  "Move card",
                  undefined,
                  [
                    ...columns.map((column) => ({
                      text: column.name,
                      onPress: () => moveCard(task, column.id),
                    })),
                    { text: "Cancel", style: "cancel" as const },
                  ],
                ),
            },
          ]
        : []),
      ...(canDeleteCards
        ? [
            {
              text: "Delete",
              style: "destructive" as const,
              onPress: () =>
                Alert.alert("Delete this card?", undefined, [
                  { text: "Cancel", style: "cancel" },
                  {
                    text: "Delete",
                    style: "destructive",
                    onPress: () =>
                      void archiveStaffTask(token, task.id)
                        .then(() => removeCard(task.id))
                        .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Could not delete card.")),
                  },
                ]),
            },
          ]
        : []),
      { text: "Cancel", style: "cancel" },
    ]);
  }

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
        <View style={[staffStyles.scroll, { flexShrink: 0, paddingBottom: 8 }]}>
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
                  <Ionicons name="mail-outline" size={18} color={colors.muted} />
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
                <Pressable
                  style={staffStyles.iconBtn}
                  onPress={() => {
                    setCreateColumnId(board?.columns[0]?.id);
                    setCreateOpen(true);
                  }}
                  accessibilityLabel="Create task"
                >
                  <Ionicons name="add" size={20} color={colors.text} />
                </Pressable>
              ) : null}
            </View>
          </View>
          {error ? <Notice tone="danger">{error}</Notice> : null}
        </View>
        {board ? (
          <StaffKanban
            board={board}
            filters={filters}
            sort={sort}
            canCreate={canCreate}
            onOpenCard={(task) => router.push(staffTaskHref(task.id))}
            onLongPressCard={openCardMenu}
            onAddCard={(columnId) => {
              setCreateColumnId(columnId);
              setCreateOpen(true);
            }}
          />
        ) : (
          <View style={{ paddingHorizontal: 16, gap: 12 }}>
            <View style={staffStyles.skeleton} />
            <View style={staffStyles.skeleton} />
          </View>
        )}
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
          defaultColumnId={createColumnId}
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
        <FolderSheetFrame
          visible={Boolean(renameCard)}
          title="Rename card"
          onClose={() => setRenameCard(null)}
          footer={
            <Button
              label="Save"
              kind="primary"
              onPress={() => {
                if (!renameCard || !renameTitle.trim()) return;
                const nextTitle = renameTitle.trim();
                const cardId = renameCard.id;
                setBoard((current) =>
                  current
                    ? {
                        ...current,
                        columns: current.columns.map((column) => ({
                          ...column,
                          tasks: column.tasks.map((task) => (task.id === cardId ? { ...task, title: nextTitle } : task)),
                        })),
                      }
                    : current,
                );
                setRenameCard(null);
                void patchStaffTask(token, cardId, { title: nextTitle }).catch((caught: unknown) => {
                  setError(caught instanceof Error ? caught.message : "Could not rename card.");
                  void load();
                });
              }}
            />
          }
        >
          <TextInput
            style={staffStyles.input}
            value={renameTitle}
            onChangeText={setRenameTitle}
            placeholder="Card title"
            placeholderTextColor={colors.muted}
          />
        </FolderSheetFrame>
      </SafeAreaView>
    </StaffGate>
  );
}
