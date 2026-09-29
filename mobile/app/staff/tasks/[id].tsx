import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import * as Linking from "expo-linking";
import { useLocalSearchParams, useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { AppHeader } from "@/components/AppHeader";
import { FolderSheetFrame } from "@/components/folders/FolderSheetFrame";
import { StaffAccessDenied } from "@/components/staff/StaffAccessDenied";
import { StaffAssigneePicker } from "@/components/staff/StaffAssigneePicker";
import { StaffGate } from "@/components/staff/StaffGate";
import { StaffTaskActivity } from "@/components/staff/taskDetail/StaffTaskActivity";
import { StaffTaskAttachments } from "@/components/staff/taskDetail/StaffTaskAttachments";
import { StaffTaskComments } from "@/components/staff/taskDetail/StaffTaskComments";
import { StaffTaskDescription } from "@/components/staff/taskDetail/StaffTaskDescription";
import { StaffTaskDetails } from "@/components/staff/taskDetail/StaffTaskDetails";
import { StaffTaskHeader } from "@/components/staff/taskDetail/StaffTaskHeader";
import { StaffTaskRelations } from "@/components/staff/taskDetail/StaffTaskRelations";
import { StaffTaskTitleField } from "@/components/staff/taskDetail/StaffTaskTitleField";
import { staffStyles } from "@/components/staff/staffStyles";
import { useStaffPoll } from "@/components/staff/useStaffPoll";
import { Button, Notice } from "@/components/ui";
import {
  addStaffChecklist,
  addStaffChecklistItem,
  addStaffRelation,
  archiveStaffTask,
  commentStaffTask,
  deleteStaffAttachment,
  deleteStaffComment,
  editStaffComment,
  fetchStaffAttachmentUrl,
  fetchStaffBoard,
  fetchStaffTask,
  isStaffForbidden,
  moveStaffTask,
  patchStaffChecklistItem,
  patchStaffTask,
  setStaffAssignees,
  setStaffTaskLabels,
  uploadStaffAttachment,
  watchStaffTask,
  type StaffBoardDetail,
  type StaffTaskDetail,
} from "@/lib/api.staff";
import { useAuth } from "@/lib/auth";
import { useStaffPermissions } from "@/lib/staffPermissions";
import { PRIORITIES, dueInputValue, parseDueInput } from "@/lib/staffUi";

export default function StaffTaskDetailScreen() {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const id = (Array.isArray(params.id) ? params.id[0] : params.id)?.trim() ?? "";
  const router = useRouter();
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const { can, me } = useStaffPermissions();
  const [task, setTask] = useState<StaffTaskDetail | null>(null);
  const [board, setBoard] = useState<StaffBoardDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);
  const [comment, setComment] = useState("");
  const [titleDraft, setTitleDraft] = useState("");
  const [descDraft, setDescDraft] = useState("");
  const [dueDraft, setDueDraft] = useState("");
  const [itemDraft, setItemDraft] = useState<Record<string, string>>({});
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const [uploadLabel, setUploadLabel] = useState<string | null>(null);
  const [statusOpen, setStatusOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [priorityOpen, setPriorityOpen] = useState(false);
  const dirty = useRef(false);
  const titleTimer = useRef(0);
  const descTimer = useRef(0);
  const savedTimer = useRef(0);
  const titleRef = useRef(titleDraft);
  const descRef = useRef(descDraft);
  const taskRef = useRef(task);
  titleRef.current = titleDraft;
  descRef.current = descDraft;
  taskRef.current = task;

  const load = useCallback(async () => {
    if (!token || !id || dirty.current) return;
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
    if (!token) return;
    const current = taskRef.current;
    if (!current) return;
    const previous = current;
    markSaving();
    setTask({ ...current, ...optimistic });
    try {
      const result = await patchStaffTask(token, current.id, body);
      dirty.current = false;
      setTask(result.task);
      markSaved();
      setError(null);
    } catch (caught) {
      setTask(previous);
      setSaveState("idle");
      setError(caught instanceof Error ? caught.message : "Could not update task.");
    }
  }

  function markSaving() {
    clearTimeout(savedTimer.current);
    setSaveState("saving");
  }

  function markSaved() {
    setSaveState("saved");
    clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSaveState("idle"), 1600) as unknown as number;
  }

  function flushTitle() {
    const next = titleRef.current.trim();
    const current = taskRef.current;
    if (!current || !next || next === current.title) return;
    dirty.current = true;
    void patch({ title: next }, { title: next });
  }

  function flushDesc() {
    const next = descRef.current;
    const current = taskRef.current;
    if (!current || next === (current.description ?? "")) return;
    dirty.current = true;
    void patch({ description: next }, { description: next });
  }

  useEffect(() => {
    return () => {
      clearTimeout(titleTimer.current);
      clearTimeout(descTimer.current);
      flushTitle();
      flushDesc();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function moveTo(columnId: string) {
    if (!token || !task || !board) return;
    const previous = task;
    setTask({ ...task, columnId });
    const column = board.columns.find((item) => item.id === columnId);
    const last = column?.tasks.filter((item) => item.id !== task.id).at(-1);
    try {
      await moveStaffTask(token, task.id, { columnId, afterRank: last?.rank ?? null, beforeRank: null });
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
    } catch (caught) {
      setTask(previous);
      setError(caught instanceof Error ? caught.message : "Could not update assignees.");
    }
  }

  const mutate = Boolean(task?.canMutate);
  const canEdit = mutate && can("board.cards.edit");
  const canMove = mutate && can("board.cards.move");
  const canAssign = mutate && can("board.cards.assign");
  const canComment = can("board.comments.create");
  const canLists = can("board.checklists.manage");
  const columnName = board?.columns.find((column) => column.id === task?.columnId)?.name ?? "Status";
  const people = board?.people?.length ? board.people : task?.assignees ?? [];
  const priorityChoices = PRIORITIES.filter((value) => value !== "urgent" || task?.priority === "urgent");

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
            {!task ? (
              <>
                <View style={[staffStyles.skeleton, { height: 32, width: 180 }]} />
                <View style={staffStyles.skeleton} />
                {error ? <Notice tone="danger">{error}</Notice> : null}
              </>
            ) : (
              <>
                <StaffTaskHeader
                  boardName={board?.name ?? null}
                  columnName={columnName}
                  saveState={saveState}
                  canMove={canMove}
                  onBack={() => {
                    flushTitle();
                    flushDesc();
                    router.back();
                  }}
                  onStatus={() => setStatusOpen(true)}
                />
                <StaffTaskTitleField
                  value={titleDraft}
                  canEdit={canEdit}
                  onChange={(value) => {
                    dirty.current = true;
                    setTitleDraft(value);
                    clearTimeout(titleTimer.current);
                    titleTimer.current = setTimeout(flushTitle, 500) as unknown as number;
                  }}
                  onBlur={flushTitle}
                />
                {error ? <Notice tone="danger">{error}</Notice> : null}
                <StaffTaskDescription
                  value={descDraft}
                  canEdit={canEdit}
                  onChange={(value) => {
                    dirty.current = true;
                    setDescDraft(value);
                    clearTimeout(descTimer.current);
                    descTimer.current = setTimeout(flushDesc, 700) as unknown as number;
                  }}
                  onBlur={flushDesc}
                />
                <StaffTaskDetails
                  task={task}
                  board={board}
                  columnName={columnName}
                  dueDraft={dueDraft}
                  canEdit={canEdit}
                  canMove={canMove}
                  canAssign={canAssign}
                  onStatus={() => setStatusOpen(true)}
                  onPriority={() => setPriorityOpen(true)}
                  onWatch={() =>
                    void watchStaffTask(token, task.id, !task.watching)
                      .then(() => setTask({ ...task, watching: !task.watching }))
                      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Could not update watch."))
                  }
                  onAssignees={() => setAssignOpen(true)}
                  onRemoveAssignee={(staffId) => {
                    const person = task.assignees.find((item) => item.id === staffId);
                    if (person) void toggleAssignee(person);
                  }}
                  onToggleLabel={(labelId) => {
                    const next = task.labelIds.includes(labelId)
                      ? task.labelIds.filter((item) => item !== labelId)
                      : [...task.labelIds, labelId];
                    const previous = task;
                    setTask({ ...task, labelIds: next });
                    void setStaffTaskLabels(token, task.id, next)
                      .then((result) => setTask(result.task))
                      .catch((caught: unknown) => {
                        setTask(previous);
                        setError(caught instanceof Error ? caught.message : "Could not update labels.");
                      });
                  }}
                  onDueChange={setDueDraft}
                  onDueBlur={() => {
                    const next = parseDueInput(dueDraft);
                    if (next === undefined) {
                      setError("Use YYYY-MM-DD for the due date.");
                      setDueDraft(dueInputValue(task.dueAt));
                      return;
                    }
                    if (next !== task.dueAt) void patch({ dueAt: next }, { dueAt: next });
                  }}
                />
                <StaffTaskRelations
                  relations={task.relations}
                  canEdit={canEdit}
                  onLink={(kind, targetId, label) =>
                    void addStaffRelation(token, task.id, { kind, targetId, label })
                      .then((result) => setTask(result.task))
                      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Could not add relation."))
                  }
                />
                <StaffTaskActivity activity={task.activity} columns={board?.columns} />
                <StaffTaskComments
                  comments={task.comments}
                  draft={comment}
                  staffId={me?.staff.id ?? null}
                  canComment={canComment}
                  canModerate={Boolean(task.boardRole === "admin" || me?.isSuperAdmin)}
                  onDraft={setComment}
                  onPost={() => {
                    if (!comment.trim()) return;
                    void commentStaffTask(token, task.id, comment.trim())
                      .then((result) => {
                        setTask(result.task);
                        setComment("");
                      })
                      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Could not post comment."));
                  }}
                  onEdit={(commentId, body) => {
                    if (!body) return;
                    void editStaffComment(token, commentId, body)
                      .then((result) => setTask(result.task))
                      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Could not edit comment."));
                  }}
                  onDelete={(commentId) =>
                    void deleteStaffComment(token, commentId)
                      .then(() => load())
                      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Could not delete comment."))
                  }
                />
                <StaffTaskAttachments
                  attachments={task.attachments}
                  uploadLabel={uploadLabel}
                  canUpload={can("board.attachments.upload")}
                  canDelete={can("board.attachments.delete") && mutate}
                  onOpen={(fileId) =>
                    void fetchStaffAttachmentUrl(token, fileId)
                      .then((body) => Linking.openURL(body.url))
                      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Could not open attachment."))
                  }
                  onUpload={(file) => {
                    setUploadLabel("Uploading…");
                    void uploadStaffAttachment(token, task.id, file)
                      .then((result) => {
                        setTask(result.task);
                        setUploadLabel(null);
                      })
                      .catch((caught: unknown) => {
                        setUploadLabel(null);
                        setError(caught instanceof Error ? caught.message : "Could not upload the attachment.");
                      });
                  }}
                  onDelete={(fileId) =>
                    void deleteStaffAttachment(token, fileId)
                      .then(() => load())
                      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Could not remove attachment."))
                  }
                />
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
                            borderColor: item.done ? "#00d8f0" : "#1e2530",
                            backgroundColor: item.done ? "#00d8f0" : "transparent",
                          }}
                        />
                        <Text style={[staffStyles.muted, item.done && { textDecorationLine: "line-through" }]}>{item.title}</Text>
                      </Pressable>
                    ))}
                    {canLists ? (
                      <TextInput
                        style={staffStyles.input}
                        placeholder="Add item"
                        placeholderTextColor="#8b93a3"
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
                {can("board.cards.delete") && mutate ? (
                  <Button
                    label="Delete task"
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
        </KeyboardAvoidingView>
        <FolderSheetFrame visible={statusOpen} title="Status" onClose={() => setStatusOpen(false)}>
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
          {priorityChoices.map((value) => (
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
