import { Pressable, ScrollView, Text, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { AppHeader } from "@/components/AppHeader";
import { StaffGate } from "@/components/staff/StaffGate";
import { staffStyles } from "@/components/staff/staffStyles";
import { staffBoardsHref, staffMembersHref, staffRolesHref, staffTasksHref } from "@/lib/api.staff";
import { useStaffPermissions } from "@/lib/staffPermissions";
import { colors } from "@/lib/theme";

function HubRow({
  label,
  hint,
  onPress,
}: {
  label: string;
  hint: string;
  onPress: () => void;
}) {
  return (
    <Pressable style={staffStyles.hubRow} onPress={onPress}>
      <View style={{ flex: 1 }}>
        <Text style={staffStyles.hubLabel}>{label}</Text>
        <Text style={staffStyles.hubHint}>{hint}</Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color={colors.muted} />
    </Pressable>
  );
}

export default function StaffHubScreen() {
  const router = useRouter();
  const { can, me } = useStaffPermissions();
  const role = me?.isSuperAdmin ? "Super Admin" : me?.roles[0]?.name || "Staff";

  return (
    <StaffGate permission="staff.access">
      <SafeAreaView style={staffStyles.page} edges={["top"]}>
        <AppHeader padded />
        <ScrollView contentContainerStyle={staffStyles.scroll}>
          <Text style={staffStyles.eyebrow}>Operations</Text>
          <Text style={staffStyles.title}>Staff Tools</Text>
          <Text style={staffStyles.subtitle}>
            {(me?.staff.department || "Internal").toUpperCase()} · {role}
          </Text>
          {can("board.view") ? (
            <HubRow label="Task Boards" hint="Single-lane boards and cards" onPress={() => router.push(staffBoardsHref())} />
          ) : null}
          {can("board.view") ? (
            <HubRow label="My Tasks" hint="Assigned, watching, and created" onPress={() => router.push(staffTasksHref())} />
          ) : null}
          {can("staff.members.view") ? (
            <HubRow label="Staff" hint="Members, read-only" onPress={() => router.push(staffMembersHref())} />
          ) : null}
          {can("staff.roles.view") ? (
            <HubRow label="Roles & Permissions" hint="Role names and counts" onPress={() => router.push(staffRolesHref())} />
          ) : null}
        </ScrollView>
      </SafeAreaView>
    </StaffGate>
  );
}
