import { useCallback, useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import * as Linking from "expo-linking";
import { useFocusEffect, useRouter } from "expo-router";
import { Avatar } from "@/components/Avatar";
import { Notice } from "@/components/ui";
import { deleteAccount, fetchBillingStatus, type BillingStatus } from "@/lib/api";
import { fetchFriends } from "@/lib/api.friends";
import { useAuth } from "@/lib/auth";
import { formatBytes, planLabel } from "@/lib/format";
import { publicShareUrl } from "@/lib/supabase";
import { useSocialUnread } from "@/lib/socialUnread";
import { getSupabase } from "@/lib/supabase";
import { colors } from "@/lib/theme";

interface ProfileRow {
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  is_verified: boolean | null;
  is_private: boolean | null;
}

interface Quota {
  storage_used_bytes: number;
  storage_limit_bytes: number;
}

export default function SettingsScreen() {
  const router = useRouter();
  const { session, signOut } = useAuth();
  const userId = session?.user.id ?? "";
  const token = session?.access_token;
  const { friendsUnread } = useSocialUnread();
  const [profile, setProfile] = useState<ProfileRow | null>(null);
  const [quota, setQuota] = useState<Quota | null>(null);
  const [billing, setBilling] = useState<BillingStatus | null>(null);
  const [friendCount, setFriendCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    void (async () => {
      const supabase = getSupabase();
      const [profileResult, quotaResult] = await Promise.all([
        supabase
          .from("profiles")
          .select("username, display_name, avatar_url, is_verified, is_private")
          .eq("id", userId)
          .maybeSingle(),
        supabase.from("user_storage").select("storage_used_bytes, storage_limit_bytes").eq("user_id", userId).maybeSingle(),
      ]);
      if (cancelled) return;
      if (profileResult.error) setError(profileResult.error.message);
      else setProfile(profileResult.data as ProfileRow | null);
      if (!quotaResult.error && quotaResult.data) setQuota(quotaResult.data as Quota);
      if (session?.access_token) {
        const next = await fetchBillingStatus(session.access_token).catch(() => null);
        if (!cancelled && next) setBilling(next);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, session?.access_token]);

  useFocusEffect(
    useCallback(() => {
      if (!token) {
        setFriendCount(null);
        return;
      }
      void fetchFriends(token)
        .then((friends) => setFriendCount(friends.length))
        .catch(() => undefined);
    }, [token]),
  );

  function confirmDelete() {
    Alert.alert(
      "Delete this account?",
      "Removes your Replayr login, cloud clips, and quota. Local files on Windows stay until you delete them there.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete account",
          style: "destructive",
          onPress: () => {
            Alert.alert("This cannot be undone.", "Delete the account and all cloud clips?", [
              { text: "Cancel", style: "cancel" },
              { text: "Delete forever", style: "destructive", onPress: () => void onDelete() },
            ]);
          },
        },
      ],
    );
  }

  async function onDelete() {
    if (!session?.access_token) return;
    setBusy(true);
    setError(null);
    try {
      await deleteAccount(session.access_token);
      await signOut();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not delete this account.");
    } finally {
      setBusy(false);
    }
  }

  if (!session) {
    return (
      <View style={styles.center}>
        <Text style={styles.title}>Settings</Text>
        <Text style={styles.muted}>Sign in to manage your Replayr account.</Text>
      </View>
    );
  }

  const used = quota?.storage_used_bytes ?? 0;
  const limit = quota?.storage_limit_bytes ?? 0;
  const percent = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const displayName = profile?.display_name || profile?.username || session.user.email || "Player";
  const handle = profile?.username ? `@${profile.username}` : "Choose a username in the desktop app";
  const friendsSubtitle =
    friendCount == null ? "See who you play with" : friendCount === 0 ? "No friends yet" : `${friendCount} friend${friendCount === 1 ? "" : "s"}`;

  return (
    <ScrollView contentContainerStyle={styles.page} showsVerticalScrollIndicator={false}>
      <Notice tone="danger">{error}</Notice>

      <View style={styles.hero}>
        <Avatar name={displayName} uri={profile?.avatar_url} size={72} />
        <View style={styles.heroCopy}>
          <View style={styles.nameRow}>
            <Text style={styles.displayName}>{displayName}</Text>
            {profile?.is_verified ? (
              <View style={styles.verified}>
                <Text style={styles.verifiedText}>Verified</Text>
              </View>
            ) : null}
          </View>
          <Text style={styles.muted}>{handle}</Text>
        </View>
      </View>

      {quota ? (
        <View style={styles.card}>
          <Text style={styles.cardLabel}>{planLabel(billing?.plan || "free")} · Cloud storage</Text>
          <View style={styles.bar}>
            <View style={[styles.fill, { width: `${percent}%` }]} />
          </View>
          <Text style={styles.muted}>
            {formatBytes(used)} of {formatBytes(limit)} used
          </Text>
        </View>
      ) : null}

      <View style={styles.card}>
        <SettingsRow
          icon="card-outline"
          title={billing?.premium ? "Manage Premium" : "Replayr Premium — $4.99/mo"}
          subtitle={billing?.premium ? "Open billing on replayr.tv" : "100 GB, original uploads, no watermark"}
          onPress={() => void Linking.openURL(`${publicShareUrl()}/account`)}
          last
        />
      </View>

      <View style={styles.card}>
        <View style={[styles.row, profile?.username ? undefined : styles.rowLast]}>
          <View style={styles.iconWrap}>
            <Ionicons name="lock-closed-outline" size={18} color={colors.text} />
          </View>
          <View style={styles.copy}>
            <Text style={styles.rowTitle}>Private account</Text>
            <Text style={styles.muted}>Only friends can see your clips, posts, and bio.</Text>
          </View>
          <Switch
            value={Boolean(profile?.is_private)}
            disabled={busy || !userId}
            onValueChange={(next) => {
              void (async () => {
                setBusy(true);
                setError(null);
                const { error: updateError } = await getSupabase()
                  .from("profiles")
                  .update({ is_private: next })
                  .eq("id", userId);
                if (updateError) setError(updateError.message);
                else setProfile((current) => (current ? { ...current, is_private: next } : current));
                setBusy(false);
              })();
            }}
            trackColor={{ false: colors.raised, true: colors.accent }}
          />
        </View>
        {profile?.username ? (
          <SettingsRow
            icon="person-outline"
            title="View profile"
            subtitle={`@${profile.username}`}
            last
            onPress={() => router.replace("/account")}
          />
        ) : null}
      </View>

      <View style={styles.card}>
        <SettingsRow
          icon="people-outline"
          title="Friends"
          subtitle={friendsSubtitle}
          pip={friendsUnread}
          onPress={() => router.push("/friends")}
        />
      </View>

      <View style={styles.card}>
        <InfoRow icon="mail-outline" title="Email" subtitle={session.user.email || "—"} />
        <InfoRow
          icon="at-outline"
          title="Username"
          subtitle={profile?.username || "Not set yet — choose one in the desktop app."}
          last
        />
      </View>

      <View style={styles.card}>
        <SettingsRow icon="log-out-outline" title="Sign out" subtitle="Stay signed in on this phone until you do." onPress={() => void signOut()} last />
      </View>

      <View style={styles.card}>
        <SettingsRow
          icon="trash-outline"
          title={busy ? "Deleting…" : "Delete account"}
          subtitle="Removes cloud clips and this login."
          danger
          last
          onPress={confirmDelete}
        />
      </View>

      <View style={styles.card}>
        <SettingsRow
          icon="shield-outline"
          title="Privacy"
          onPress={() => void Linking.openURL("https://www.replayr.tv/privacy")}
        />
        <SettingsRow
          icon="document-text-outline"
          title="Terms"
          last
          onPress={() => void Linking.openURL("https://www.replayr.tv/terms")}
        />
      </View>
    </ScrollView>
  );
}

function SettingsRow({
  icon,
  title,
  subtitle,
  onPress,
  pip,
  danger,
  last,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  subtitle?: string;
  onPress: () => void;
  pip?: boolean;
  danger?: boolean;
  last?: boolean;
}) {
  return (
    <Pressable style={[styles.row, last && styles.rowLast]} onPress={onPress} disabled={title.startsWith("Deleting")}>
      <View style={[styles.iconWrap, danger && styles.iconWrapDanger]}>
        <Ionicons name={icon} size={18} color={danger ? colors.danger : colors.text} />
      </View>
      <View style={styles.copy}>
        <Text style={[styles.rowTitle, danger && styles.dangerText]}>{title}</Text>
        {subtitle ? <Text style={styles.muted}>{subtitle}</Text> : null}
      </View>
      {pip ? <View style={styles.pip} /> : null}
      <Ionicons name="chevron-forward" size={18} color={colors.muted} />
    </Pressable>
  );
}

function InfoRow({
  icon,
  title,
  subtitle,
  last,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  subtitle: string;
  last?: boolean;
}) {
  return (
    <View style={[styles.row, last && styles.rowLast]}>
      <View style={styles.iconWrap}>
        <Ionicons name={icon} size={18} color={colors.text} />
      </View>
      <View style={styles.copy}>
        <Text style={styles.rowTitle}>{title}</Text>
        <Text style={styles.muted}>{subtitle}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { padding: 16, paddingBottom: 40, gap: 14, backgroundColor: colors.bg },
  center: { flex: 1, backgroundColor: colors.bg, padding: 16, gap: 12, justifyContent: "center" },
  title: { color: colors.text, fontSize: 28, fontWeight: "800" },
  muted: { color: colors.muted, fontSize: 13, lineHeight: 18 },
  hero: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    backgroundColor: colors.card,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.border,
  },
  heroCopy: { flex: 1, gap: 4 },
  nameRow: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  displayName: { color: colors.text, fontSize: 22, fontWeight: "800" },
  verified: {
    backgroundColor: "rgba(127, 208, 239, 0.14)",
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  verifiedText: { color: colors.accent, fontSize: 11, fontWeight: "700" },
  card: {
    backgroundColor: colors.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: "hidden",
    padding: 14,
    gap: 10,
  },
  cardLabel: { color: colors.text, fontSize: 15, fontWeight: "700" },
  bar: { height: 8, backgroundColor: colors.raised, borderRadius: 8, overflow: "hidden" },
  fill: { height: 8, backgroundColor: colors.accent },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  rowLast: { borderBottomWidth: 0, paddingBottom: 0 },
  iconWrap: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: colors.raised,
    alignItems: "center",
    justifyContent: "center",
  },
  iconWrapDanger: { backgroundColor: "rgba(227, 107, 107, 0.14)" },
  copy: { flex: 1, gap: 2 },
  rowTitle: { color: colors.text, fontSize: 16, fontWeight: "700" },
  dangerText: { color: colors.danger },
  pip: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.accent },
});
