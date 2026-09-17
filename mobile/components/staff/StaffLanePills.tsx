import { Pressable, ScrollView, Text } from "react-native";
import { staffStyles } from "@/components/staff/staffStyles";
import type { StaffBoardDetail } from "@/lib/api.staff";

export function StaffLanePills({
  columns,
  activeId,
  onSelect,
}: {
  columns: StaffBoardDetail["columns"];
  activeId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingVertical: 4 }}>
      {columns.map((column) => {
        const on = column.id === activeId;
        return (
          <Pressable key={column.id} onPress={() => onSelect(column.id)} style={[staffStyles.pill, on && staffStyles.pillOn]}>
            <Text style={[staffStyles.pillText, on && staffStyles.pillTextOn]}>
              {column.name} · {column.tasks.length}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}
