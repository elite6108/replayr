import { Stack, usePathname, useRouter, type Href } from "expo-router";
import * as Linking from "expo-linking";
import { useEffect } from "react";
import { View } from "react-native";
import { AuthProvider } from "@/lib/auth";
import { SocialUnreadProvider } from "@/lib/socialUnread";
import { StaffPermissionsProvider } from "@/lib/staffPermissions";
import { AnnouncementHost } from "@/components/AnnouncementHost";
import { AppTabBar, shouldShowAppTabBar } from "@/components/AppTabBar";
import { folderHref } from "@/lib/api.folders";
import { staffBoardHref, staffTaskHref } from "@/lib/api.staff";
import { threadHref } from "@/lib/api.messages";
import { openReplayrLink } from "@/lib/openReplayrLink";
import { targetFromPushData } from "@/lib/registerStaffPush";
import * as Notifications from "expo-notifications";
import { installMobileTelemetry } from "@/lib/telemetry";
import { colors } from "@/lib/theme";

export { ErrorBoundary } from "expo-router";

function RootShell() {
  const pathname = usePathname();
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={{ flex: 1 }}>
        <Stack
          screenOptions={{
            headerTintColor: colors.accent,
            headerStyle: { backgroundColor: colors.raised },
            contentStyle: { backgroundColor: colors.bg },
          }}
        >
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="signin" options={{ title: "Sign in" }} />
          <Stack.Screen
            name="c/[slug]"
            options={{
              headerShown: false,
              animation: "fade",
              fullScreenGestureEnabled: false,
              gestureResponseDistance: { start: 20 },
            }}
          />
          <Stack.Screen
            name="s/[slug]"
            options={{
              headerShown: false,
              animation: "fade",
            }}
          />
          <Stack.Screen name="game/[slug]" options={{ title: "Game" }} />
          <Stack.Screen name="friends" options={{ title: "Following" }} />
          <Stack.Screen name="search" options={{ title: "Search" }} />
          <Stack.Screen name="u/[username]" options={{ title: "Profile" }} />
          <Stack.Screen name="messages/[id]" options={{ title: "Chat", headerBackTitle: "Back" }} />
          <Stack.Screen name="settings" options={{ title: "Settings" }} />
          <Stack.Screen
            name="editor/[slug]"
            options={{
              headerShown: false,
              animation: "slide_from_bottom",
              gestureDirection: "horizontal",
              fullScreenGestureEnabled: false,
              gestureResponseDistance: { start: 16 },
            }}
          />
          <Stack.Screen name="staff" options={{ headerShown: false }} />
          <Stack.Screen name="folders" options={{ headerShown: false }} />
          <Stack.Screen name="auth/callback" options={{ title: "Signing in" }} />
        </Stack>
      </View>
      {shouldShowAppTabBar(pathname) ? <AppTabBar /> : null}
    </View>
  );
}

export default function RootLayout() {
  const router = useRouter();

  useEffect(() => {
    installMobileTelemetry();
  }, []);

  useEffect(() => {
    function open(url: string | null) {
      const link = openReplayrLink(url);
      if (link.kind === "folder") {
        router.push(folderHref(link.folderId));
        return;
      }
      if (link.kind === "clip") {
        router.push(link.href);
        return;
      }
      if (link.kind === "screenshot") {
        router.push(link.href as Href);
        return;
      }
      if (link.kind === "staff-task") {
        router.push(staffTaskHref(link.taskId));
        return;
      }
      if (link.kind === "staff-board") {
        router.push(staffBoardHref(link.boardId));
      }
    }
    const sub = Linking.addEventListener("url", (event) => open(event.url));
    void Linking.getInitialURL().then(open);
    function openPush(data: unknown) {
      const target = targetFromPushData(data);
      if (!target) return;
      if (target.kind === "staff-task") {
        router.push(staffTaskHref(target.taskId));
        return;
      }
      if (target.kind === "clip") {
        router.push(`/c/${target.slug}` as Href);
        return;
      }
      router.push(threadHref(target.conversationId));
    }
    const tap = Notifications.addNotificationResponseReceivedListener((response) => {
      openPush(response.notification.request.content.data);
    });
    void Notifications.getLastNotificationResponseAsync().then((response) => {
      openPush(response?.notification.request.content.data);
    });
    return () => {
      sub.remove();
      tap.remove();
    };
  }, [router]);

  return (
    <AuthProvider>
      <StaffPermissionsProvider>
        <SocialUnreadProvider>
          <AnnouncementHost />
          <RootShell />
        </SocialUnreadProvider>
      </StaffPermissionsProvider>
    </AuthProvider>
  );
}
