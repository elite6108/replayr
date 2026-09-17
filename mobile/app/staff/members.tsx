import { useCallback, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { AppHeader } from "@/components/AppHeader";
import { StaffGate } from "@/components/staff/StaffGate";
import { staffStyles } from "@/components/staff/staffStyles";
import { Notice } from "@/components/ui";
import { fetchStaffMembers, staffHref, type StaffMember } from "@/lib/api.staff";
import { useAuth } from "@/lib/auth";
import { useStaffPoll } from "@/components/staff/useStaffPoll";

export default function StaffMembersScreen() {
  const router = useRouter();
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const [members, setMembers] = useState<StaffMember[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const body = await fetchStaffMembers(token);
      setMembers(body.members);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load staff.");
    }
  }, [token]);

  useStaffPoll(load);

  return (
    <StaffGate permission="staff.members.view">
      <SafeAreaView style={staffStyles.page} edges={["top"]}>
        <AppHeader padded />
        <ScrollView contentContainerStyle={staffStyles.scroll}>
          <Pressable onPress={() => router.replace(staffHref())}>
            <Text style={staffStyles.back}>Staff Tools</Text>
          </Pressable>
          <Text style={staffStyles.eyebrow}>Operations</Text>
          <Text style={staffStyles.title}>Staff</Text>
          <Text style={staffStyles.subtitle}>Read-only member list.</Text>
          {error ? <Notice tone="danger">{error}</Notice> : null}
          {members.map((member) => (
            <View key={member.id} style={staffStyles.card}>
              <Text style={staffStyles.cardTitle}>{member.displayName}</Text>
              <Text style={staffStyles.muted}>
                {member.roles.map((role) => role.name).join(", ") || "Staff"}
                {member.jobTitle ? ` · ${member.jobTitle}` : ""}
              </Text>
              <Text style={staffStyles.muted}>{member.status}</Text>
            </View>
          ))}
          {members.length === 0 && !error ? <Text style={staffStyles.muted}>No staff members.</Text> : null}
        </ScrollView>
      </SafeAreaView>
    </StaffGate>
  );
}
