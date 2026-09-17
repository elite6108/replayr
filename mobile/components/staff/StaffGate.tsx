import { useEffect, useRef, type ReactNode } from "react";
import { Text, View } from "react-native";
import { usePathname, useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { AppHeader } from "@/components/AppHeader";
import { StaffAccessDenied } from "@/components/staff/StaffAccessDenied";
import { staffStyles } from "@/components/staff/staffStyles";
import { useAuth } from "@/lib/auth";
import { setPendingDeepLink } from "@/lib/pendingDeepLink";
import { useStaffPermissions } from "@/lib/staffPermissions";

export function StaffSkeleton() {
  return (
    <SafeAreaView style={staffStyles.page} edges={["top"]}>
      <AppHeader padded />
      <View style={{ padding: 16, gap: 10 }}>
        <View style={[staffStyles.skeleton, { height: 28, width: 140 }]} />
        <View style={staffStyles.skeleton} />
        <View style={staffStyles.skeleton} />
        <View style={staffStyles.skeleton} />
      </View>
    </SafeAreaView>
  );
}

export function StaffGate({
  permission,
  children,
}: {
  permission: string;
  children: ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { session } = useAuth();
  const { me, loading, denied, can } = useStaffPermissions();
  const hadStaff = useRef(false);

  useEffect(() => {
    if (me) hadStaff.current = true;
  }, [me]);

  useEffect(() => {
    if (session === undefined || loading) return;
    if (!session) {
      void setPendingDeepLink(pathname);
      router.replace("/signin");
      return;
    }
    if (denied && hadStaff.current) {
      router.replace("/account");
    }
  }, [denied, loading, pathname, router, session]);

  if (session === undefined || loading) return <StaffSkeleton />;
  if (!session) {
    return (
      <SafeAreaView style={staffStyles.page} edges={["top"]}>
        <AppHeader padded />
        <View style={{ padding: 16 }}>
          <Text style={staffStyles.muted}>Sign in to open staff tools.</Text>
        </View>
      </SafeAreaView>
    );
  }
  if (denied || !can(permission)) {
    return <StaffAccessDenied />;
  }
  return children;
}
