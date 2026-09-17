import { Pressable, ScrollView, Switch, Text, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { AppHeader } from "@/components/AppHeader";
import { StaffGate } from "@/components/staff/StaffGate";
import { staffStyles } from "@/components/staff/staffStyles";
import { staffBoardsHref, staffMembersHref, staffRolesHref, staffTasksHref, patchStaffMe } from "@/lib/api.staff";
import { useAuth } from "@/lib/auth";
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
  const { can, me, reload } = useStaffPermissions();
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const role = me?.isSuperAdmin ? "Super Admin" : me?.roles[0]?.name || "Staff";
  const emailOn = me?.notifyBoardEmail !== false;
  const ownEmailOn = Boolean(me?.notifyOwnBoardEmail);

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
          <View style={staffStyles.card}>
            <View style={staffStyles.memberHeading}>
              <View style={{ flex: 1 }}>
                <Text style={staffStyles.cardTitle}>Email me about board activity</Text>
                <Text style={staffStyles.muted}>
                  When others add, move, assign, comment, or change due dates on boards you can access.
                </Text>
              </View>
              <Switch
                value={emailOn}
                onValueChange={(next) => {
                  if (!token) return;
                  void patchStaffMe(token, { notifyBoardEmail: next }).then(reload);
                }}
                trackColor={{ false: colors.border, true: colors.accent }}
                thumbColor={colors.text}
              />
            </View>
          </View>
          <View style={staffStyles.card}>
            <View style={staffStyles.memberHeading}>
              <View style={{ flex: 1 }}>
                <Text style={staffStyles.cardTitle}>Email me about my own edits on boards I own</Text>
                <Text style={staffStyles.muted}>
                  Off by default. Turn this on if you want a copy when you add, move, assign, comment, or change due dates.
                </Text>
              </View>
              <Switch
                value={ownEmailOn}
                disabled={!emailOn}
                onValueChange={(next) => {
                  if (!token) return;
                  void patchStaffMe(token, { notifyOwnBoardEmail: next }).then(reload);
                }}
                trackColor={{ false: colors.border, true: colors.accent }}
                thumbColor={colors.text}
              />
            </View>
          </View>
        </ScrollView>
      </SafeAreaView>
    </StaffGate>
  );
}
