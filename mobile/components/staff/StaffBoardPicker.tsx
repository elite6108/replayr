import { Pressable, Text } from "react-native";
import { FolderSheetFrame } from "@/components/folders/FolderSheetFrame";
import { staffStyles } from "@/components/staff/staffStyles";
import type { StaffBoardSummary } from "@/lib/api.staff";
import { visibilityLabel } from "@/lib/staffUi";

export function StaffBoardPicker({
  visible,
  boards,
  activeId,
  onClose,
  onSelect,
}: {
  visible: boolean;
  boards: StaffBoardSummary[];
  activeId?: string;
  onClose: () => void;
  onSelect: (id: string) => void;
}) {
  return (
    <FolderSheetFrame visible={visible} title="Boards" onClose={onClose}>
      {boards.map((board) => {
        const on = board.id === activeId;
        return (
          <Pressable
            key={board.id}
            style={[staffStyles.hubRow, on && staffStyles.pillOn]}
            onPress={() => {
              onSelect(board.id);
              onClose();
            }}
          >
            <Text style={staffStyles.hubLabel}>{board.name}</Text>
            <Text style={staffStyles.hubHint}>{visibilityLabel(board.visibility)}</Text>
          </Pressable>
        );
      })}
      {boards.length === 0 ? <Text style={staffStyles.muted}>No boards yet.</Text> : null}
    </FolderSheetFrame>
  );
}
