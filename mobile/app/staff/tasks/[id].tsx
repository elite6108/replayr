import { useCallback, useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import * as Linking from "expo-linking";
import { useLocalSearchParams, useRouter, type Href } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { AppHeader } from "@/components/AppHeader";
import { FolderSheetFrame } from "@/components/folders/FolderSheetFrame";
import { StaffAccessDenied } from "@/components/staff/StaffAccessDenied";
import { StaffAssigneePicker } from "@/components/staff/StaffAssigneePicker";
import { StaffGate } from "@/components/staff/StaffGate";
import { StaffLabelPills } from "@/components/staff/StaffLabelPills";
import { StaffPriorityChip } from "@/components/staff/StaffPriorityChip";
import { staffStyles } from "@/components/staff/staffStyles";
import { useStaffPoll } from "@/components/staff/useStaffPoll";
import { Button, Notice } from "@/components/ui";
import {
  addStaffChecklist,
  addStaffChecklistItem,
  archiveStaffTask,
  commentStaffTask,
  fetchStaffAttachmentUrl,
  fetchStaffBoard,
  fetchStaffTask,
  isStaffForbidden,
  moveStaffTask,
  patchStaffChecklistItem,
  patchStaffTask,
  setStaffAssignees,
  setStaffTaskLabels,
  staffBoardHref,
  watchStaffTask,
  type StaffBoardDetail,
  type StaffTaskDetail,
} from "@/lib/api.staff";
import { useAuth } from "@/lib/auth";
import { formatTimeAgo } from "@/lib/format";
import { useStaffPermissions } from "@/lib/staffPermissions";
import { PRIORITIES, dueInputValue, parseDueInput, relationHref } from "@/lib/staffUi";
import { colors } from "@/lib/theme";

export default function StaffTaskDetailScreen() {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const id = (Array.isArray(params.id) ? params.id[0] : params.id)?.trim() ?? "";
  const router = useRouter();
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const { can } = useStaffPermissions();
  const [task, setTask] = useState<StaffTaskDetail | null>(null);
  const [board, setBoard] = useState<StaffBoardDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);
  const [comment, setComment] = useState("");
  const [titleDraft, setTitleDraft] = useState("");
  const [descDraft, setDescDraft] = useState("");
  const [dueDraft, setDueDraft] = useState("");
  const [itemDraft, setItemDraft] = useState<Record<string, string>>({});
  const [statusOpen, setStatusOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [priorityOpen, setPriorityOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [labelsOpen, setLabelsOpen] = useState(false);

  const load = useCallback(async () => {
    if (!token || !id) return;
    try {
      const detail = await fetchStaffTask(token, id);
      setTask(detail.task);
      setTitleDraft(detail.task.title);
      setDescDraft(detail.task.description ?? "");
      setDueDraft(dueInputValue(detail.task.dueAt));
      setDenied(false);
      setError(null);
      const boardBody = await fetchStaffBoard(token, detail.task.boardId).catch(() => null);
      if (boardBody) setBoard(boardBody.board);
    } catch (caught) {
      if (isStaffForbidden(caught)) {
        setDenied(true);
        setTask(null);
        return;
      }
      setError(caught instanceof Error ? caught.message : "Could not load that task.");
    }
  }, [id, token]);

  useStaffPoll(load);

  async function patch(body: Record<string, unknown>, optimistic: Partial<StaffTaskDetail>) {
    if (!token || !task) return;
    const previous = task;
    setTask({ ...task, ...optimistic });
    try {
      const result = await patchStaffTask(token, task.id, body);
      setTask(result.task);
      setTitleDraft(result.task.title);
      setDescDraft(result.task.description ?? "");
      setDueDraft(dueInputValue(result.task.dueAt));
      setError(null);
    } catch (caught) {
      setTask(previous);
      setError(caught instanceof Error ? caught.message : "Could not update task.");
    }
  }

  async function moveTo(columnId: string) {
    if (!token || !task || !board) return;
    const previous = task;
    setTask({ ...task, columnId });
    const column = board.columns.find((item) => item.id === columnId);
    const last = column?.tasks.filter((item) => item.id !== task.id).at(-1);
    try {
      await moveStaffTask(token, task.id, { columnId, afterRank: last?.rank ?? null, beforeRank: null });
      setError(null);
      setStatusOpen(false);
      void load();
    } catch (caught) {
      setTask(previous);
      setError(caught instanceof Error ? caught.message : "Could not move task.");
    }
  }

  async function toggleAssignee(person: { id: string; displayName: string }) {
    if (!token || !task) return;
    const on = task.assignees.some((item) => item.id === person.id);
    const nextPeople = on ? task.assignees.filter((item) => item.id !== person.id) : [...task.assignees, person];
    const previous = task;
    setTask({ ...task, assignees: nextPeople });
    try {
      const result = await setStaffAssignees(token, task.id, nextPeople.map((item) => item.id));
      setTask(result.task);
      setError(null);
    } catch (caught) {
      setTask(previous);
      setError(caught instanceof Error ? caught.message : "Could not update assignees.");
    }
  }

  async function toggleLabel(labelId: string) {
    if (!token || !task) return;
    const next = task.labelIds.includes(labelId)
      ? task.labelIds.filter((item) => item !== labelId)
      : [...task.labelIds, labelId];
    const previous = task;
    setTask({ ...task, labelIds: next });
    try {
      const result = await setStaffTaskLabels(token, task.id, next);
      setTask(result.task);
      setError(null);
    } catch (caught) {
      setTask(previous);
      setError(caught instanceof Error ? caught.message : "Could not update labels.");
    }
  }

  async function sendComment() {
    if (!token || !task || !comment.trim()) return;
    try {
      const result = await commentStaffTask(token, task.id, comment.trim());
      setTask(result.task);
      setComment("");
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not post comment.");
    }
  }

  function openRelation(kind: string, targetId: string, label: string | null) {
    const href = relationHref(kind, targetId, label);
    if (!href) return;
    if (href.startsWith("http")) {
      void Linking.openURL(href);
      return;
    }
    router.push(href as Href);
  }

  const mutate = Boolean(task?.canMutate);
  const canEdit = mutate && can("board.cards.edit");
  const canMove = mutate && can("board.cards.move");
  const canAssign = mutate && can("board.cards.assign");
  const canComment = can("board.comments.create");
  const canLists = can("board.checklists.manage");
  const columnName = board?.columns.find((column) => column.id === task?.columnId)?.name ?? "Status";
  const people = board?.people?.length ? board.people : task?.assignees ?? [];

  if (denied) {
    return (
      <StaffGate permission="board.view">
        <StaffAccessDenied message="Access denied. You do not have permission to open this task." />
      </StaffGate>
    );
  }

  return (
    <StaffGate permission="board.view">
      <SafeAreaView style={staffStyles.page} edges={["top"]}>
        <AppHeader padded />
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
          <ScrollView contentContainerStyle={staffStyles.scroll} keyboardShouldPersistTaps="handled">
            <Pressable onPress={() => router.back()}>
              <Text style={staffStyles.back}>Back</Text>
            </Pressable>
            {!task ? (
              <>
                <View style={[staffStyles.skeleton, { height: 32, width: 180 }]} />
                <View style={staffStyles.skeleton} />
                <View style={staffStyles.skeleton} />
                {error ? <Notice tone="danger">{error}</Notice> : null}
              </>
            ) : (
              <>
                <Text style={staffStyles.eyebrow}>Operations</Text>
                {canEdit ? (
                  <TextInput
                    style={[staffStyles.input, { fontSize: 22, fontWeight: "800" }]}
                    value={titleDraft}
                    onChangeText={setTitleDraft}
                    onBlur={() => {
                      if (titleDraft.trim() && titleDraft.trim() !== task.title) {
                        void patch({ title: titleDraft.trim() }, { title: titleDraft.trim() });
                      }
                    }}
                  />
                ) : (
                  <Text style={staffStyles.title}>{task.title}</Text>
                )}
                {error ? <Notice tone="danger">{error}</Notice> : null}
                {canEdit ? (
                  <Pressable style={staffStyles.addBtn} onPress={() => setAddOpen(true)}>
                    <Text style={staffStyles.addBtnText}>Add</Text>
                  </Pressable>
                ) : null}
                <View style={staffStyles.row}>
                  <Pressable
                    style={staffStyles.pill}
                    onPress={() => (canMove ? setStatusOpen(true) : undefined)}
                    disabled={!canMove}
                  >
                    <Text style={staffStyles.pillTextOn}>{columnName}</Text>
                  </Pressable>
                  <Pressable onPress={() => (canEdit ? setPriorityOpen(true) : undefined)} disabled={!canEdit}>
                    <StaffPriorityChip priority={task.priority} />
                  </Pressable>
                  <Pressable
                    style={staffStyles.pill}
                    onPress={() =>
                      void watchStaffTask(token, task.id, !task.watching)
                        .then(() => setTask({ ...task, watching: !task.watching }))
                        .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Could not update watch."))
                    }
                  >
                    <Text style={staffStyles.pillTextOn}>{task.watching ? "Watching" : "Watch"}</Text>
                  </Pressable>
                  {board ? (
                    <Pressable style={staffStyles.pill} onPress={() => router.push(staffBoardHref(board.id))}>
                      <Text style={staffStyles.pillTextOn}>{board.name}</Text>
                    </Pressable>
                  ) : null}
                </View>
                <Text style={staffStyles.section}>Description</Text>
                {canEdit ? (
                  <TextInput
                    style={[staffStyles.input, { minHeight: 96, textAlignVertical: "top" }]}
                    multiline
                    value={descDraft}
                    onChangeText={setDescDraft}
                    placeholder="Add a description"
                    placeholderTextColor={colors.muted}
                    onBlur={() => {
                      if (descDraft !== (task.description ?? "")) {
                        void patch({ description: descDraft }, { description: descDraft });
                      }
                    }}
                  />
                ) : (
                  <Text style={staffStyles.muted}>{task.description || "No description."}</Text>
                )}
                <Text style={staffStyles.section}>Assignees</Text>
                <Pressable style={staffStyles.row} onPress={() => (canAssign ? setAssignOpen(true) : undefined)}>
                  {task.assignees.length ? (
                    task.assignees.map((person) => (
                      <View key={person.id} style={staffStyles.pill}>
                        <Text style={staffStyles.pillTextOn}>{person.displayName}</Text>
                      </View>
                    ))
                  ) : (
                    <Text style={staffStyles.muted}>{canAssign ? "Tap to assign" : "Unassigned"}</Text>
                  )}
                </Pressable>
                <Text style={staffStyles.section}>Due</Text>
                {canEdit ? (
                  <TextInput
                    style={staffStyles.input}
                    value={dueDraft}
                    onChangeText={setDueDraft}
                    placeholder="YYYY-MM-DD"
                    placeholderTextColor={colors.muted}
                    onBlur={() => {
                      const next = parseDueInput(dueDraft);
                      if (next === undefined) {
                        setError("Use YYYY-MM-DD for the due date.");
                        setDueDraft(dueInputValue(task.dueAt));
                        return;
                      }
                      if (next !== task.dueAt) void patch({ dueAt: next }, { dueAt: next });
                    }}
                  />
                ) : (
                  <Text style={staffStyles.muted}>{task.dueAt ? new Date(task.dueAt).toLocaleDateString() : "No due date"}</Text>
                )}
                {board?.labels.length ? (
                  <>
                    <Text style={staffStyles.section}>Labels</Text>
                    <StaffLabelPills
                      labels={board.labels}
                      selectedIds={task.labelIds}
                      onToggle={canEdit ? toggleLabel : undefined}
                    />
                  </>
                ) : null}
                <Text style={staffStyles.section}>Checklists</Text>
                {task.checklists.map((list) => (
                  <View key={list.id} style={staffStyles.card}>
                    <Text style={staffStyles.cardTitle}>{list.title}</Text>
                    {list.items.map((item) => (
                      <Pressable
                        key={item.id}
                        style={staffStyles.checklistRow}
                        disabled={!canLists}
                        onPress={() =>
                          void patchStaffChecklistItem(token, item.id, { done: !item.done })
                            .then((body) => setTask(body.task))
                            .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Could not update checklist."))
                        }
                      >
                        <View
                          style={{
                            width: 20,
                            height: 20,
                            borderRadius: 4,
                            borderWidth: 1,
                            borderColor: item.done ? colors.accent : colors.border,
                            backgroundColor: item.done ? colors.accent : "transparent",
                          }}
                        />
                        <Text style={[staffStyles.muted, item.done && { textDecorationLine: "line-through" }]}>{item.title}</Text>
                      </Pressable>
                    ))}
                    {canLists ? (
                      <TextInput
                        style={staffStyles.input}
                        placeholder="Add item"
                        placeholderTextColor={colors.muted}
                        value={itemDraft[list.id] ?? ""}
                        onChangeText={(value) => setItemDraft((current) => ({ ...current, [list.id]: value }))}
                        onSubmitEditing={() => {
                          const value = (itemDraft[list.id] ?? "").trim();
                          if (!value) return;
                          void addStaffChecklistItem(token, list.id, value)
                            .then((body) => {
                              setTask(body.task);
                              setItemDraft((current) => ({ ...current, [list.id]: "" }));
                            })
                            .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Could not add item."));
                        }}
                      />
                    ) : null}
                  </View>
                ))}
                {canLists && mutate ? (
                  <Button label="Add checklist" onPress={() => void addStaffChecklist(token, task.id, "Checklist").then((body) => setTask(body.task))} />
                ) : null}
                <Text style={staffStyles.section}>Comments</Text>
                {task.comments.map((item) => (
                  <View key={item.id} style={staffStyles.comment}>
                    <Text style={staffStyles.commentName}>
                      {item.authorName} <Text style={staffStyles.muted}>{formatTimeAgo(item.createdAt)}</Text>
                    </Text>
                    <Text style={staffStyles.commentBody}>{item.body}</Text>
                  </View>
                ))}
                {task.comments.length === 0 ? <Text style={staffStyles.muted}>No comments yet.</Text> : null}
                <Text style={staffStyles.section}>Attachments</Text>
                {task.attachments.map((file) => (
                  <Pressable
                    key={file.id}
                    style={staffStyles.hubRow}
                    onPress={() =>
                      void fetchStaffAttachmentUrl(token, file.id)
                        .then((body) => Linking.openURL(body.url))
                        .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Could not open attachment."))
                    }
                  >
                    <Text style={staffStyles.hubLabel}>{file.filename}</Text>
                  </Pressable>
                ))}
                {task.attachments.length === 0 ? <Text style={staffStyles.muted}>No attachments.</Text> : null}
                <Text style={staffStyles.section}>Related</Text>
                {task.relations.map((row) => {
                  const href = relationHref(row.kind, row.targetId, row.label);
                  if (!href) return null;
                  return (
                    <Pressable key={row.id} style={staffStyles.hubRow} onPress={() => openRelation(row.kind, row.targetId, row.label)}>
                      <View>
                        <Text style={staffStyles.hubLabel}>{row.label || row.targetId}</Text>
                        <Text style={staffStyles.hubHint}>{row.kind}</Text>
                      </View>
                    </Pressable>
                  );
                })}
                {task.relations.filter((row) => relationHref(row.kind, row.targetId, row.label)).length === 0 ? (
                  <Text style={staffStyles.muted}>No related Replayr items.</Text>
                ) : null}
                <Text style={staffStyles.section}>Activity</Text>
                {task.activity.map((item) => (
                  <Text key={item.id} style={staffStyles.muted}>
                    {item.action} · {formatTimeAgo(item.createdAt)}
                  </Text>
                ))}
                {can("board.cards.delete") && mutate ? (
                  <Button
                    label="Delete card"
                    kind="danger"
                    onPress={() =>
                      Alert.alert("Delete this card?", undefined, [
                        { text: "Cancel", style: "cancel" },
                        {
                          text: "Delete",
                          style: "destructive",
                          onPress: () =>
                            void archiveStaffTask(token, task.id)
                              .then(() => router.back())
                              .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Could not delete card.")),
                        },
                      ])
                    }
                  />
                ) : null}
              </>
            )}
          </ScrollView>
          {task && canComment ? (
            <View style={[staffStyles.composer, { paddingBottom: 16 }]}>
              <TextInput
                style={staffStyles.input}
                value={comment}
                onChangeText={setComment}
                placeholder="Comment. Use @username to mention."
                placeholderTextColor={colors.muted}
              />
              <Button label="Comment" kind="primary" disabled={!comment.trim()} onPress={() => void sendComment()} />
            </View>
          ) : null}
        </KeyboardAvoidingView>
        <FolderSheetFrame visible={statusOpen} title="Move" onClose={() => setStatusOpen(false)}>
          {(board?.columns ?? []).map((column) => (
            <Pressable
              key={column.id}
              style={[staffStyles.hubRow, task?.columnId === column.id && staffStyles.pillOn]}
              onPress={() => void moveTo(column.id)}
            >
              <Text style={staffStyles.hubLabel}>{column.name}</Text>
            </Pressable>
          ))}
        </FolderSheetFrame>
        <FolderSheetFrame visible={priorityOpen} title="Priority" onClose={() => setPriorityOpen(false)}>
          {PRIORITIES.map((value) => (
            <Pressable
              key={value}
              style={[staffStyles.hubRow, task?.priority === value && staffStyles.pillOn]}
              onPress={() => {
                setPriorityOpen(false);
                void patch({ priority: value }, { priority: value });
              }}
            >
              <Text style={staffStyles.hubLabel}>{value}</Text>
            </Pressable>
          ))}
        </FolderSheetFrame>
        <FolderSheetFrame visible={addOpen} title="Add to card" onClose={() => setAddOpen(false)}>
          {board?.labels.length ? (
            <Pressable
              style={staffStyles.hubRow}
              onPress={() => {
                setAddOpen(false);
                setLabelsOpen(true);
              }}
            >
              <Text style={staffStyles.hubLabel}>Labels</Text>
            </Pressable>
          ) : null}
          {canAssign ? (
            <Pressable
              style={staffStyles.hubRow}
              onPress={() => {
                setAddOpen(false);
                setAssignOpen(true);
              }}
            >
              <Text style={staffStyles.hubLabel}>Members</Text>
            </Pressable>
          ) : null}
          {canEdit ? (
            <Pressable
              style={staffStyles.hubRow}
              onPress={() => {
                setAddOpen(false);
                setPriorityOpen(true);
              }}
            >
              <Text style={staffStyles.hubLabel}>Priority</Text>
            </Pressable>
          ) : null}
          {canLists && mutate ? (
            <Pressable
              style={staffStyles.hubRow}
              onPress={() => {
                setAddOpen(false);
                void addStaffChecklist(token, task?.id ?? "", "Checklist").then((body) => setTask(body.task));
              }}
            >
              <Text style={staffStyles.hubLabel}>Checklist</Text>
            </Pressable>
          ) : null}
        </FolderSheetFrame>
        <FolderSheetFrame visible={labelsOpen} title="Labels" onClose={() => setLabelsOpen(false)}>
          {board?.labels.length ? (
            <StaffLabelPills labels={board.labels} selectedIds={task?.labelIds ?? []} onToggle={canEdit ? toggleLabel : undefined} />
          ) : (
            <Text style={staffStyles.muted}>No labels on this board.</Text>
          )}
        </FolderSheetFrame>
        <StaffAssigneePicker
          visible={assignOpen}
          people={people}
          selected={task?.assignees ?? []}
          onClose={() => setAssignOpen(false)}
          onToggle={(person) => void toggleAssignee(person)}
        />
      </SafeAreaView>
    </StaffGate>
  );
}
