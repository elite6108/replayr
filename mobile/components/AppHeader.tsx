import { useEffect, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Image } from "expo-image";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useRouter } from "expo-router";
import { Avatar } from "@/components/Avatar";
import { NotificationsSheet } from "@/components/NotificationsSheet";
import { fetchOwnProfile } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useSocialUnread } from "@/lib/socialUnread";
import { colors } from "@/lib/theme";

export function AppHeader({ padded = false }: { padded?: boolean }) {
  const router = useRouter();
  const { session } = useAuth();
  const token = session?.access_token;
  const userId = session?.user.id;
  const { notificationsUnread } = useSocialUnread();
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [profile, setProfile] = useState<{
    username: string | null;
    display_name: string | null;
    avatar_url: string | null;
  } | null>(null);

  useEffect(() => {
    if (!userId) {
      setProfile(null);
      return;
    }
    void fetchOwnProfile(userId).then(setProfile).catch(() => setProfile(null));
  }, [userId]);

  return (
    <>
      <View style={[styles.header, padded && styles.padded]}>
        <Image
          source={require("../assets/images/replayr-logo.png")}
          style={styles.brandLogo}
          contentFit="contain"
          accessibilityLabel="Replayr"
        />
        <View style={styles.headerActions}>
          <Pressable
            style={({ pressed }) => [styles.bell, pressed && styles.bellPressed]}
            onPress={() => router.push("/search")}
            hitSlop={8}
          >
            <Ionicons name="search" size={20} color={colors.text} />
          </Pressable>
          <Pressable
            style={({ pressed }) => [styles.bell, pressed && styles.bellPressed]}
            onPress={() => {
              if (!session) {
                router.push("/signin");
                return;
              }
              setNotificationsOpen(true);
            }}
            hitSlop={8}
          >
            <Ionicons name="notifications-outline" size={22} color={colors.text} />
            {notificationsUnread > 0 ? <View style={styles.bellPip} /> : null}
          </Pressable>
          <Pressable onPress={() => router.push(session ? "/account" : "/signin")}>
            <Avatar name={profile?.display_name || profile?.username || session?.user.email} uri={profile?.avatar_url} size={36} />
          </Pressable>
        </View>
      </View>
      <NotificationsSheet visible={notificationsOpen} token={token} onClose={() => setNotificationsOpen(false)} />
    </>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: 4,
    paddingBottom: 10,
  },
  padded: { paddingHorizontal: 16 },
  brandLogo: { width: 148, height: 40 },
  headerActions: { flexDirection: "row", alignItems: "center", gap: 12 },
  bell: {
    position: "relative",
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  bellPressed: { borderColor: colors.accentRing },
  bellPip: {
    position: "absolute",
    top: 6,
    right: 6,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.accent,
  },
});
