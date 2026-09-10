import { Stack, usePathname, useRouter } from "expo-router";
import * as Linking from "expo-linking";
import { useEffect } from "react";
import { View } from "react-native";
import { AuthProvider } from "@/lib/auth";
import { SocialUnreadProvider } from "@/lib/socialUnread";
import { AnnouncementHost } from "@/components/AnnouncementHost";
import { AppTabBar, shouldShowAppTabBar } from "@/components/AppTabBar";
import { folderHref } from "@/lib/api.folders";
import { openReplayrLink } from "@/lib/openReplayrLink";
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
          <Stack.Screen name="c/[slug]" options={{ headerShown: false, animation: "fade" }} />
          <Stack.Screen name="game/[slug]" options={{ title: "Game" }} />
          <Stack.Screen name="friends" options={{ title: "Following" }} />
          <Stack.Screen name="search" options={{ title: "Search" }} />
          <Stack.Screen name="u/[username]" options={{ title: "Profile" }} />
          <Stack.Screen name="messages/[id]" options={{ title: "Chat" }} />
          <Stack.Screen name="settings" options={{ title: "Settings" }} />
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
      }
    }
    const sub = Linking.addEventListener("url", (event) => open(event.url));
    void Linking.getInitialURL().then(open);
    return () => sub.remove();
  }, [router]);

  return (
    <AuthProvider>
      <SocialUnreadProvider>
        <AnnouncementHost />
        <RootShell />
      </SocialUnreadProvider>
    </AuthProvider>
  );
}
