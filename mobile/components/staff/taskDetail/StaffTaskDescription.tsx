import { Text, TextInput, View } from "react-native";
import { staffStyles } from "@/components/staff/staffStyles";
import { colors } from "@/lib/theme";

const MAX = 1000;

export function StaffTaskDescription({
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
  return (
    <View style={staffStyles.sectionCard}>
      <View style={staffStyles.sectionHead}>
        <Text style={staffStyles.cardTitle}>Description</Text>
        {canEdit ? (
          <Text style={staffStyles.muted}>
            {value.length}/{MAX}
          </Text>
        ) : null}
      </View>
      {canEdit ? (
        <TextInput
          style={[staffStyles.input, staffStyles.textarea]}
          multiline
          value={value}
          maxLength={MAX}
          onChangeText={onChange}
          onBlur={onBlur}
          placeholder="Add a description"
          placeholderTextColor={colors.muted}
        />
      ) : (
        <Text style={staffStyles.muted}>{value || "No description."}</Text>
      )}
    </View>
  );
}
