import { Pressable, ScrollView, Text, View } from "react-native";
import { StaffTaskCard } from "@/components/staff/StaffTaskCard";
import { staffStyles } from "@/components/staff/staffStyles";
import type { StaffBoardCard, StaffBoardDetail } from "@/lib/api.staff";
import { columnTone } from "@/lib/staffUi";
import { colors } from "@/lib/theme";

const TONE_BAR: Record<string, string> = {
  slate: "rgba(148, 163, 184, 0.55)",
  blue: "rgba(96, 165, 250, 0.65)",
  cyan: "rgba(69, 216, 245, 0.7)",
  purple: "rgba(167, 139, 250, 0.65)",
  green: "rgba(110, 201, 140, 0.7)",
};

export function StaffKanbanColumn({
  name,
  tasks,
  labels,
  canCreate,
  onOpenCard,
  onLongPressCard,
  onAddCard,
}: {
  name: string;
  tasks: StaffBoardCard[];
  labels?: StaffBoardDetail["labels"];
  canCreate: boolean;
  onOpenCard: (task: StaffBoardCard) => void;
  onLongPressCard: (task: StaffBoardCard) => void;
  onAddCard: () => void;
}) {
  const tone = columnTone(name);
  return (
    <View style={[staffStyles.kanbanColumn, { borderLeftWidth: 3, borderLeftColor: TONE_BAR[tone] ?? colors.border }]}>
      <View style={staffStyles.kanbanHead}>
        <Text style={staffStyles.kanbanTitle} numberOfLines={1}>
          {name}
        </Text>
        <Text style={staffStyles.kanbanCount}>{tasks.length}</Text>
      </View>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={staffStyles.kanbanBody}
        nestedScrollEnabled
        keyboardShouldPersistTaps="handled"
      >
        {tasks.map((task) => (
          <StaffTaskCard
            key={task.id}
            task={task}
            labels={labels}
            onPress={() => onOpenCard(task)}
            onLongPress={() => onLongPressCard(task)}
          />
        ))}
        {tasks.length === 0 ? <Text style={staffStyles.muted}>No tasks here yet</Text> : null}
      </ScrollView>
      {canCreate ? (
        <Pressable onPress={onAddCard} accessibilityLabel={`Add a card to ${name}`}>
          <Text style={staffStyles.kanbanAdd}>+ Add a card</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
