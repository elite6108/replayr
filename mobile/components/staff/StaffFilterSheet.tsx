import { Pressable, Text, TextInput, View } from "react-native";
import { FolderSheetFrame } from "@/components/folders/FolderSheetFrame";
import { Button } from "@/components/ui";
import { staffStyles } from "@/components/staff/staffStyles";
import type { StaffBoardDetail } from "@/lib/api.staff";
import { EMPTY_BOARD_FILTERS, PRIORITIES, type BoardFilters } from "@/lib/staffUi";
import { colors } from "@/lib/theme";

export function StaffFilterSheet({
  visible,
  filters,
  people,
  labels,
  onChange,
  onClose,
}: {
  visible: boolean;
  filters: BoardFilters;
  people: StaffBoardDetail["people"];
  labels: StaffBoardDetail["labels"];
  onChange: (next: BoardFilters) => void;
  onClose: () => void;
}) {
  return (
    <FolderSheetFrame
      visible={visible}
      title="Filter"
      onClose={onClose}
      footer={<Button label="Clear filters" onPress={() => onChange(EMPTY_BOARD_FILTERS)} />}
    >
      <TextInput
        style={staffStyles.input}
        placeholder="Search title, labels, id"
        placeholderTextColor={colors.muted}
        value={filters.q}
        onChangeText={(q) => onChange({ ...filters, q })}
      />
      <Text style={staffStyles.section}>Priority</Text>
      <View style={staffStyles.row}>
        {["", ...PRIORITIES.filter((item) => item !== "none")].map((value) => (
          <Pressable
            key={value || "any"}
            style={[staffStyles.pill, filters.priority === value && staffStyles.pillOn]}
            onPress={() => onChange({ ...filters, priority: value })}
          >
            <Text style={[staffStyles.pillText, filters.priority === value && staffStyles.pillTextOn]}>
              {value || "Any"}
            </Text>
          </Pressable>
        ))}
      </View>
      <Text style={staffStyles.section}>Due</Text>
      <View style={staffStyles.row}>
        {[
          ["", "Any"],
          ["overdue", "Overdue"],
          ["soon", "Soon"],
          ["unset", "No due"],
        ].map(([value, label]) => (
          <Pressable
            key={value || "any-due"}
            style={[staffStyles.pill, filters.due === value && staffStyles.pillOn]}
            onPress={() => onChange({ ...filters, due: value })}
          >
            <Text style={[staffStyles.pillText, filters.due === value && staffStyles.pillTextOn]}>{label}</Text>
          </Pressable>
        ))}
      </View>
      <Text style={staffStyles.section}>Assignee</Text>
      <View style={staffStyles.row}>
        <Pressable
          style={[staffStyles.pill, !filters.assigneeId && staffStyles.pillOn]}
          onPress={() => onChange({ ...filters, assigneeId: "" })}
        >
          <Text style={[staffStyles.pillText, !filters.assigneeId && staffStyles.pillTextOn]}>Anyone</Text>
        </Pressable>
        <Pressable
          style={[staffStyles.pill, filters.assigneeId === "unassigned" && staffStyles.pillOn]}
          onPress={() => onChange({ ...filters, assigneeId: "unassigned" })}
        >
          <Text style={[staffStyles.pillText, filters.assigneeId === "unassigned" && staffStyles.pillTextOn]}>Unassigned</Text>
        </Pressable>
        {people.map((person) => (
          <Pressable
            key={person.id}
            style={[staffStyles.pill, filters.assigneeId === person.id && staffStyles.pillOn]}
            onPress={() => onChange({ ...filters, assigneeId: person.id })}
          >
            <Text style={[staffStyles.pillText, filters.assigneeId === person.id && staffStyles.pillTextOn]}>
              {person.displayName}
            </Text>
          </Pressable>
        ))}
      </View>
      {labels.length ? (
        <>
          <Text style={staffStyles.section}>Label</Text>
          <View style={staffStyles.row}>
            <Pressable
              style={[staffStyles.pill, !filters.labelId && staffStyles.pillOn]}
              onPress={() => onChange({ ...filters, labelId: "" })}
            >
              <Text style={[staffStyles.pillText, !filters.labelId && staffStyles.pillTextOn]}>Any</Text>
            </Pressable>
            {labels.map((label) => (
              <Pressable
                key={label.id}
                style={[staffStyles.pill, filters.labelId === label.id && staffStyles.pillOn]}
                onPress={() => onChange({ ...filters, labelId: label.id })}
              >
                <Text style={[staffStyles.pillText, filters.labelId === label.id && staffStyles.pillTextOn]}>{label.name}</Text>
              </Pressable>
            ))}
          </View>
        </>
      ) : null}
    </FolderSheetFrame>
  );
}
