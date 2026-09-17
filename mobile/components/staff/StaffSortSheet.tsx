import { Pressable, Text } from "react-native";
import { FolderSheetFrame } from "@/components/folders/FolderSheetFrame";
import { staffStyles } from "@/components/staff/staffStyles";

const OPTIONS = [
  ["rank", "Board order"],
  ["priority", "Priority"],
  ["due", "Due date"],
  ["title", "Title"],
] as const;

export function StaffSortSheet({
  visible,
  value,
  onChange,
  onClose,
}: {
  visible: boolean;
  value: string;
  onChange: (next: string) => void;
  onClose: () => void;
}) {
  return (
    <FolderSheetFrame visible={visible} title="Sort" onClose={onClose}>
      {OPTIONS.map(([id, label]) => (
        <Pressable
          key={id}
          style={[staffStyles.hubRow, value === id && staffStyles.pillOn]}
          onPress={() => {
            onChange(id);
            onClose();
          }}
        >
          <Text style={staffStyles.hubLabel}>{label}</Text>
        </Pressable>
      ))}
    </FolderSheetFrame>
  );
}
