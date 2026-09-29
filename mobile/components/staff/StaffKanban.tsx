import { ScrollView, useWindowDimensions } from "react-native";
import { StaffKanbanColumn } from "@/components/staff/StaffKanbanColumn";
import { staffStyles } from "@/components/staff/staffStyles";
import type { StaffBoardCard, StaffBoardDetail } from "@/lib/api.staff";
import { sortTasks, taskMatchesFilters, type BoardFilters } from "@/lib/staffUi";

export function StaffKanban({
  board,
  filters,
  sort,
  canCreate,
  onOpenCard,
  onLongPressCard,
  onAddCard,
}: {
  board: StaffBoardDetail;
  filters: BoardFilters;
  sort: string;
  canCreate: boolean;
  onOpenCard: (task: StaffBoardCard) => void;
  onLongPressCard: (task: StaffBoardCard) => void;
  onAddCard: (columnId: string) => void;
}) {
  const { height } = useWindowDimensions();
  const columns = board.columns.map((column) => ({
    ...column,
    tasks: sortTasks(
      column.tasks.filter((task) => taskMatchesFilters(task, filters, board.labels)),
      sort === "board" ? "rank" : sort,
    ),
  }));

  return (
    <ScrollView
      style={{ flex: 1 }}
      horizontal
      nestedScrollEnabled
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={[staffStyles.kanban, { minHeight: Math.max(360, height - 220) }]}
    >
      {columns.map((column) => (
        <StaffKanbanColumn
          key={column.id}
          name={column.name}
          tasks={column.tasks}
          labels={board.labels}
          canCreate={canCreate}
          onOpenCard={onOpenCard}
          onLongPressCard={onLongPressCard}
          onAddCard={() => onAddCard(column.id)}
        />
      ))}
    </ScrollView>
  );
}
