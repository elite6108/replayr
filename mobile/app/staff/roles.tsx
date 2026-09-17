import { useCallback, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { AppHeader } from "@/components/AppHeader";
import { StaffGate } from "@/components/staff/StaffGate";
import { staffStyles } from "@/components/staff/staffStyles";
import { Notice } from "@/components/ui";
import { fetchStaffRoles, staffHref, type StaffRole } from "@/lib/api.staff";
import { useAuth } from "@/lib/auth";
import { useStaffPoll } from "@/components/staff/useStaffPoll";

export default function StaffRolesScreen() {
  const router = useRouter();
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const [roles, setRoles] = useState<StaffRole[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const body = await fetchStaffRoles(token);
      setRoles(body.roles);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load roles.");
    }
  }, [token]);

  useStaffPoll(load);

  return (
    <StaffGate permission="staff.roles.view">
      <SafeAreaView style={staffStyles.page} edges={["top"]}>
        <AppHeader padded />
        <ScrollView contentContainerStyle={staffStyles.scroll}>
          <Pressable onPress={() => router.replace(staffHref())}>
            <Text style={staffStyles.back}>Staff Tools</Text>
          </Pressable>
          <Text style={staffStyles.eyebrow}>Operations</Text>
          <Text style={staffStyles.title}>Roles & Permissions</Text>
          <Text style={staffStyles.subtitle}>Read-only role names and counts.</Text>
          {error ? <Notice tone="danger">{error}</Notice> : null}
          {roles.map((role) => (
            <View key={role.id} style={staffStyles.card}>
              <Text style={staffStyles.cardTitle}>{role.name}</Text>
              <Text style={staffStyles.muted}>
                {role.memberCount == null ? `${role.permissions.length} permissions` : `${role.memberCount} members`}
              </Text>
            </View>
          ))}
          {roles.length === 0 && !error ? <Text style={staffStyles.muted}>No roles.</Text> : null}
        </ScrollView>
      </SafeAreaView>
    </StaffGate>
  );
}
