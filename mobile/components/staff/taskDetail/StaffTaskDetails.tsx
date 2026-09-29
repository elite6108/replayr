import { Pressable, Switch, Text, TextInput, View } from "react-native";
import { StaffLabelPills } from "@/components/staff/StaffLabelPills";
import { StaffPriorityChip } from "@/components/staff/StaffPriorityChip";
import { staffStyles } from "@/components/staff/staffStyles";
import type { StaffBoardDetail, StaffTaskDetail } from "@/lib/api.staff";
import { colors } from "@/lib/theme";

export function StaffTaskDetails({
  task,
  board,
  columnName,
  dueDraft,
  canEdit,
  canMove,
  canAssign,
  onStatus,
  onPriority,
  onWatch,
  onAssignees,
  onRemoveAssignee,
  onToggleLabel,
  onDueChange,
  onDueBlur,
}: {
  task: StaffTaskDetail;
  board: StaffBoardDetail | null;
  columnName: string;
  dueDraft: string;
  canEdit: boolean;
  canMove: boolean;
  canAssign: boolean;
  onStatus: () => void;
  onPriority: () => void;
  onWatch: () => void;
  onAssignees: () => void;
  onRemoveAssignee: (id: string) => void;
  onToggleLabel: (id: string) => void;
  onDueChange: (value: string) => void;
  onDueBlur: () => void;
}) {
  return (
    <View style={staffStyles.sectionCard}>
      <Text style={staffStyles.cardTitle}>Details</Text>
      <Text style={staffStyles.muted}>Status</Text>
      <Pressable style={staffStyles.input} onPress={onStatus} disabled={!canMove}>
        <Text style={staffStyles.hubLabel}>{columnName}</Text>
      </Pressable>
      <Text style={staffStyles.muted}>Priority</Text>
      <Pressable onPress={onPriority} disabled={!canEdit}>
        <StaffPriorityChip priority={task.priority} />
        {task.priority === "none" ? <Text style={staffStyles.muted}>None</Text> : null}
      </Pressable>
      <View style={staffStyles.memberHeading}>
        <Text style={[staffStyles.hubLabel, { flex: 1 }]}>Watching</Text>
        <Switch
          value={task.watching}
          onValueChange={onWatch}
          trackColor={{ false: colors.border, true: colors.accent }}
          thumbColor={colors.text}
        />
      </View>
      <Text style={staffStyles.muted}>Assignees</Text>
      <View style={staffStyles.row}>
        {task.assignees.map((person) => (
          <Pressable
            key={person.id}
            style={staffStyles.chip}
            onPress={() => (canAssign ? onRemoveAssignee(person.id) : undefined)}
          >
            <Text style={staffStyles.chipText}>{person.displayName}</Text>
            {canAssign ? <Text style={staffStyles.muted}>×</Text> : null}
          </Pressable>
        ))}
        {canAssign ? (
          <Pressable style={staffStyles.chip} onPress={onAssignees}>
            <Text style={staffStyles.chipText}>Add</Text>
          </Pressable>
        ) : null}
        {!task.assignees.length && !canAssign ? <Text style={staffStyles.muted}>Unassigned</Text> : null}
      </View>
      <Text style={staffStyles.muted}>Due</Text>
      {canEdit ? (
        <TextInput
          style={staffStyles.input}
          value={dueDraft}
          onChangeText={onDueChange}
          onBlur={onDueBlur}
          placeholder="YYYY-MM-DD"
          placeholderTextColor={colors.muted}
        />
      ) : (
        <Text style={staffStyles.muted}>{task.dueAt ? new Date(task.dueAt).toLocaleDateString() : "No due date"}</Text>
      )}
      {board?.labels.length ? (
        <>
          <Text style={staffStyles.muted}>Labels</Text>
          <StaffLabelPills labels={board.labels} selectedIds={task.labelIds} onToggle={canEdit ? onToggleLabel : undefined} />
        </>
      ) : null}
    </View>
  );
}
