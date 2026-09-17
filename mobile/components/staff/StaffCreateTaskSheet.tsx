import { useEffect, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { FolderSheetFrame } from "@/components/folders/FolderSheetFrame";
import { staffStyles } from "@/components/staff/staffStyles";
import { Button, Notice } from "@/components/ui";
import { createStaffTask, fetchStaffBoard, setStaffAssignees, type StaffBoardDetail, type StaffBoardSummary } from "@/lib/api.staff";
import { PRIORITIES } from "@/lib/staffUi";
import { colors } from "@/lib/theme";

export function StaffCreateTaskSheet({
  visible,
  token,
  boards,
  board,
  defaultColumnId,
  onClose,
  onCreated,
}: {
  visible: boolean;
  token: string;
  boards: StaffBoardSummary[];
  board: StaffBoardDetail | null;
  defaultColumnId?: string;
  onClose: () => void;
  onCreated: (taskId: string, boardId: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [boardId, setBoardId] = useState(board?.id ?? "");
  const [columnId, setColumnId] = useState(defaultColumnId ?? board?.columns[0]?.id ?? "");
  const [priority, setPriority] = useState("none");
  const [assigneeId, setAssigneeId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [laneBoard, setLaneBoard] = useState<StaffBoardDetail | null>(board);

  useEffect(() => {
    if (!visible) return;
    setTitle("");
    setPriority("none");
    setAssigneeId("");
    setError(null);
    setBoardId(board?.id ?? boards[0]?.id ?? "");
    setColumnId(defaultColumnId ?? board?.columns[0]?.id ?? "");
    setLaneBoard(board);
  }, [visible, board, boards, defaultColumnId]);

  useEffect(() => {
    if (!visible || !token || !boardId) return;
    if (board?.id === boardId) {
      setLaneBoard(board);
      return;
    }
    void fetchStaffBoard(token, boardId)
      .then((body) => {
        setLaneBoard(body.board);
        setColumnId((current) => body.board.columns.some((column) => column.id === current) ? current : body.board.columns[0]?.id ?? "");
      })
      .catch(() => setLaneBoard(null));
  }, [visible, token, boardId, board]);

  const columns = laneBoard?.columns ?? [];
  const people = laneBoard?.people ?? [];

  async function submit() {
    const trimmed = title.trim();
    if (!trimmed || !boardId || !columnId) {
      setError("Title, board, and lane are required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await createStaffTask(token, boardId, {
        columnId,
        title: trimmed,
        priority: priority !== "none" ? priority : undefined,
      });
      if (assigneeId) {
        await setStaffAssignees(token, created.task.id, [assigneeId]).catch(() => undefined);
      }
      onCreated(created.task.id, boardId);
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create that task.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <FolderSheetFrame
      visible={visible}
      title="Create task"
      onClose={onClose}
      footer={<Button label={busy ? "Creating…" : "Create"} kind="primary" disabled={busy} onPress={() => void submit()} />}
    >
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <TextInput
        style={staffStyles.input}
        placeholder="Task title"
        placeholderTextColor={colors.muted}
        value={title}
        onChangeText={setTitle}
      />
      <Text style={staffStyles.section}>Board</Text>
      <View style={staffStyles.row}>
        {boards.map((item) => (
          <Pressable
            key={item.id}
            style={[staffStyles.pill, boardId === item.id && staffStyles.pillOn]}
            onPress={() => setBoardId(item.id)}
          >
            <Text style={[staffStyles.pillText, boardId === item.id && staffStyles.pillTextOn]}>{item.name}</Text>
          </Pressable>
        ))}
      </View>
      <Text style={staffStyles.section}>Lane</Text>
      <View style={staffStyles.row}>
        {columns.map((column) => (
          <Pressable
            key={column.id}
            style={[staffStyles.pill, columnId === column.id && staffStyles.pillOn]}
            onPress={() => setColumnId(column.id)}
          >
            <Text style={[staffStyles.pillText, columnId === column.id && staffStyles.pillTextOn]}>{column.name}</Text>
          </Pressable>
        ))}
        {columns.length === 0 ? <Text style={staffStyles.muted}>Open a board to pick a lane.</Text> : null}
      </View>
      <Text style={staffStyles.section}>Priority</Text>
      <View style={staffStyles.row}>
        {PRIORITIES.map((value) => (
          <Pressable
            key={value}
            style={[staffStyles.pill, priority === value && staffStyles.pillOn]}
            onPress={() => setPriority(value)}
          >
            <Text style={[staffStyles.pillText, priority === value && staffStyles.pillTextOn]}>{value}</Text>
          </Pressable>
        ))}
      </View>
      {people.length ? (
        <>
          <Text style={staffStyles.section}>Assignee</Text>
          <View style={staffStyles.row}>
            <Pressable
              style={[staffStyles.pill, !assigneeId && staffStyles.pillOn]}
              onPress={() => setAssigneeId("")}
            >
              <Text style={[staffStyles.pillText, !assigneeId && staffStyles.pillTextOn]}>None</Text>
            </Pressable>
            {people.map((person) => (
              <Pressable
                key={person.id}
                style={[staffStyles.pill, assigneeId === person.id && staffStyles.pillOn]}
                onPress={() => setAssigneeId(person.id)}
              >
                <Text style={[staffStyles.pillText, assigneeId === person.id && staffStyles.pillTextOn]}>
                  {person.displayName}
                </Text>
              </Pressable>
            ))}
          </View>
        </>
      ) : null}
    </FolderSheetFrame>
  );
}
