import { Pressable, Text, View } from "react-native";
import { staffStyles } from "@/components/staff/staffStyles";
import type { StaffBoardDetail } from "@/lib/api.staff";

export function StaffLabelPills({
  labels,
  selectedIds,
  onToggle,
}: {
  labels: StaffBoardDetail["labels"];
  selectedIds: string[];
  onToggle?: (id: string) => void;
}) {
  if (!labels.length) return null;
  return (
    <View style={staffStyles.row}>
      {labels.map((label) => {
        const on = selectedIds.includes(label.id);
        if (!onToggle && !on) return null;
        return (
          <Pressable
            key={label.id}
            disabled={!onToggle}
            onPress={() => onToggle?.(label.id)}
            style={[
              staffStyles.pill,
              on && staffStyles.pillOn,
              { borderColor: label.color || undefined },
            ]}
          >
            <Text style={[staffStyles.pillText, on && staffStyles.pillTextOn]}>{label.name}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}
