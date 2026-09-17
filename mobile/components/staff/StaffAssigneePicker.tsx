import { Pressable, Text, View } from "react-native";
import { FolderSheetFrame } from "@/components/folders/FolderSheetFrame";
import { staffStyles } from "@/components/staff/staffStyles";
import { initials } from "@/lib/staffUi";
import { colors } from "@/lib/theme";

export function StaffAssigneePicker({
  visible,
  people,
  selected,
  onClose,
  onToggle,
}: {
  visible: boolean;
  people: Array<{ id: string; displayName: string }>;
  selected: Array<{ id: string; displayName: string }>;
  onClose: () => void;
  onToggle: (person: { id: string; displayName: string }) => void;
}) {
  return (
    <FolderSheetFrame visible={visible} title="Assignees" onClose={onClose}>
      {people.map((person) => {
        const on = selected.some((item) => item.id === person.id);
        return (
          <Pressable key={person.id} style={staffStyles.hubRow} onPress={() => onToggle(person)}>
            <View style={staffStyles.row}>
              <View
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 16,
                  backgroundColor: colors.card,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Text style={{ color: colors.text, fontWeight: "800" }}>{initials(person.displayName)}</Text>
              </View>
              <Text style={staffStyles.hubLabel}>{person.displayName}</Text>
            </View>
            <Text style={{ color: on ? colors.accent : colors.muted, fontWeight: "700" }}>{on ? "Assigned" : "Add"}</Text>
          </Pressable>
        );
      })}
      {people.length === 0 ? <Text style={staffStyles.muted}>No people on this board.</Text> : null}
    </FolderSheetFrame>
  );
}
