import { Pressable, Text, View } from "react-native";
import { StaffPriorityChip } from "@/components/staff/StaffPriorityChip";
import { StaffLabelPills } from "@/components/staff/StaffLabelPills";
import { staffStyles } from "@/components/staff/staffStyles";
import type { StaffBoardCard, StaffBoardDetail, StaffMyTask } from "@/lib/api.staff";
import { dueIsOverdue, formatDue, initials } from "@/lib/staffUi";
import { colors } from "@/lib/theme";

export function StaffTaskCard({
  task,
  labels,
  onPress,
  onLongPress,
}: {
  task: StaffBoardCard | StaffMyTask;
  labels?: StaffBoardDetail["labels"];
  onPress: () => void;
  onLongPress?: () => void;
}) {
  const due = formatDue(task.dueAt);
  const overdue = dueIsOverdue(task.dueAt, "completedAt" in task ? task.completedAt : null);
  const assignees = "assignees" in task ? task.assignees : [];
  const labelIds = "labelIds" in task ? task.labelIds : [];
  return (
    <Pressable style={staffStyles.card} onPress={onPress} onLongPress={onLongPress} delayLongPress={380}>
      <Text style={staffStyles.cardTitle}>{task.title}</Text>
      <View style={staffStyles.row}>
        <StaffPriorityChip priority={task.priority} />
        {due ? (
          <Text style={{ color: overdue ? colors.danger : colors.muted, fontSize: 12, fontWeight: "700" }}>
            {overdue ? "Overdue " : "Due "}
            {due}
          </Text>
        ) : null}
      </View>
      {labels?.length && labelIds.length ? <StaffLabelPills labels={labels} selectedIds={labelIds} /> : null}
      {assignees.length ? (
        <View style={staffStyles.row}>
          {assignees.slice(0, 4).map((person) => (
            <View
              key={person.id}
              style={{
                width: 24,
                height: 24,
                borderRadius: 12,
                backgroundColor: colors.card,
                borderWidth: 1,
                borderColor: colors.border,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Text style={{ color: colors.text, fontSize: 10, fontWeight: "800" }}>{initials(person.displayName)}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </Pressable>
  );
}
