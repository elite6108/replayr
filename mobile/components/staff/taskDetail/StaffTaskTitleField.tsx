import { Text, TextInput } from "react-native";
import { staffStyles } from "@/components/staff/staffStyles";
import { colors } from "@/lib/theme";

export function StaffTaskTitleField({
  value,
  canEdit,
  onChange,
  onBlur,
}: {
  value: string;
  canEdit: boolean;
  onChange: (value: string) => void;
  onBlur: () => void;
}) {
  if (!canEdit) return <Text style={staffStyles.title}>{value}</Text>;
  return (
    <TextInput
      style={[staffStyles.input, { fontSize: 22, fontWeight: "800" }]}
      value={value}
      onChangeText={onChange}
      onBlur={onBlur}
      placeholder="Task title"
      placeholderTextColor={colors.muted}
    />
  );
}
