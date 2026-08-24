import { Stack, useRouter } from "expo-router";
import * as Linking from "expo-linking";
import * as Notifications from "expo-notifications";
import { useEffect, useRef } from "react";
import { AuthProvider, useAuth } from "@/lib/auth";
import { routeFromPushData, syncPushForSession } from "@/lib/push";
import { SocialUnreadProvider } from "@/lib/socialUnread";
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
        <PushBridge />
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
        <Stack.Screen name="auth/callback" options={{ title: "Signing in" }} />
      </Stack>
      </SocialUnreadProvider>
    </AuthProvider>
  );
}

function PushBridge() {
  const router = useRouter();
  const { session } = useAuth();
  const handledResponse = useRef<string | null>(null);

  useEffect(() => {
    if (!session?.access_token) return;
    void syncPushForSession(session.access_token).catch(() => undefined);
  }, [session?.access_token]);

  useEffect(() => {
    function open(response: Notifications.NotificationResponse | null) {
      const id = response?.notification.request.identifier;
      if (!response || !id || handledResponse.current === id) return;
      handledResponse.current = id;
      routeFromPushData(response.notification.request.content.data, (href) => router.push(href));
    }
    const sub = Notifications.addNotificationResponseReceivedListener(open);
    void Notifications.getLastNotificationResponseAsync().then(open);
    return () => sub.remove();
  }, [router]);

  return null;
}
