import { Stack, usePathname, useRouter } from "expo-router";
import * as Linking from "expo-linking";
import { useEffect } from "react";
import { View } from "react-native";
import { AuthProvider } from "@/lib/auth";
import { SocialUnreadProvider } from "@/lib/socialUnread";
import { AnnouncementHost } from "@/components/AnnouncementHost";
import { AppTabBar, shouldShowAppTabBar } from "@/components/AppTabBar";
import { installMobileTelemetry } from "@/lib/telemetry";
import { colors } from "@/lib/theme";

export { ErrorBoundary } from "expo-router";

function clipPath(url: string | null) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^\/c\/([a-z0-9]{6,16})\/?$/i);
    return match?.[1] ?? null;
  } catch {
    const match = url.match(/(?:\/c\/|replay:\/\/c\/)([a-z0-9]{6,16})/i);
    return match?.[1] ?? null;
  }
}

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
          <Stack.Screen name="games/[slug]" options={{ title: "Game" }} />
          <Stack.Screen name="friends" options={{ title: "Friends" }} />
          <Stack.Screen name="search" options={{ title: "Search" }} />
          <Stack.Screen name="u/[username]" options={{ title: "Profile" }} />
          <Stack.Screen name="messages/[id]" options={{ title: "Chat" }} />
          <Stack.Screen name="settings" options={{ title: "Settings" }} />
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
      const slug = clipPath(url);
      if (slug) router.push(`/c/${slug}`);
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
