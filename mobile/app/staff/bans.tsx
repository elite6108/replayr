import { useCallback, useState } from "react";
import { Alert, Pressable, ScrollView, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { AppHeader } from "@/components/AppHeader";
import { StaffGate } from "@/components/staff/StaffGate";
import { staffStyles } from "@/components/staff/staffStyles";
import { useStaffPoll } from "@/components/staff/useStaffPoll";
import { Button, Field, Notice } from "@/components/ui";
import { createAccessBan, fetchAccessBans, liftAccessBan, type AccessBan } from "@/lib/api.bans";
import { staffHref } from "@/lib/api.staff";
import { useAuth } from "@/lib/auth";

export default function StaffBansScreen() {
  const router = useRouter();
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const [bans, setBans] = useState<AccessBan[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [accountId, setAccountId] = useState("");
  const [accountReason, setAccountReason] = useState("");
  const [ip, setIp] = useState("");
  const [ipReason, setIpReason] = useState("");

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const body = await fetchAccessBans(token);
      setBans(body.bans);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load bans.");
    }
  }, [token]);

  useStaffPoll(load);

  function confirmBan(message: string, run: () => Promise<void>) {
    Alert.alert("Ban", message, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Ban",
        style: "destructive",
        onPress: () => {
          setBusy(true);
          void run()
            .catch((caught) => setError(caught instanceof Error ? caught.message : "Could not save that ban."))
            .finally(() => setBusy(false));
        },
      },
    ]);
  }

  return (
    <StaffGate permission="users.ban">
      <SafeAreaView style={staffStyles.page} edges={["top"]}>
        <AppHeader padded />
        <ScrollView contentContainerStyle={staffStyles.scroll} keyboardShouldPersistTaps="handled">
          <Pressable onPress={() => router.replace(staffHref())}>
            <Text style={staffStyles.back}>Staff Tools</Text>
          </Pressable>
          <Text style={staffStyles.eyebrow}>People</Text>
          <Text style={staffStyles.title}>Bans</Text>
          <Text style={staffStyles.subtitle}>
            Block an account or a public IP address. The reason stays with staff and is not shown to the person who is blocked.
          </Text>
          {error ? <Notice tone="danger">{error}</Notice> : null}
          <View style={staffStyles.card}>
            <Field label="Account id" value={accountId} onChangeText={setAccountId} autoCapitalize="none" autoCorrect={false} />
            <Field label="Reason" value={accountReason} onChangeText={setAccountReason} maxLength={200} />
            <Button
              label="Ban account"
              kind="danger"
              disabled={busy || !accountId.trim() || !accountReason.trim()}
              onPress={() =>
                confirmBan("This account will not be able to use Replayr.", async () => {
                  await createAccessBan(token, { kind: "account", userId: accountId.trim(), reason: accountReason.trim() });
                  setAccountId("");
                  setAccountReason("");
                  await load();
                })
              }
            />
          </View>
          <View style={staffStyles.card}>
            <Field label="Public IP address" value={ip} onChangeText={setIp} autoCapitalize="none" autoCorrect={false} />
            <Field label="Reason" value={ipReason} onChangeText={setIpReason} maxLength={200} />
            <Button
              label="Ban IP"
              kind="danger"
              disabled={busy || !ip.trim() || !ipReason.trim()}
              onPress={() =>
                confirmBan(`Visitors from ${ip.trim()} will not reach Replayr.`, async () => {
                  await createAccessBan(token, { kind: "ip", ip: ip.trim(), reason: ipReason.trim() });
                  setIp("");
                  setIpReason("");
                  await load();
                })
              }
            />
          </View>
          {bans.map((ban) => (
            <View key={ban.id} style={staffStyles.card}>
              <Text style={staffStyles.cardTitle}>{ban.label}</Text>
              <Text style={staffStyles.muted}>
                {ban.kind === "account" ? "Account" : "IP"}
                {ban.kind === "account" ? ` · ${ban.subject}` : ""}
              </Text>
              <Text style={staffStyles.muted}>{ban.reason}</Text>
              <Button
                label="Lift ban"
                disabled={busy}
                onPress={() => {
                  Alert.alert("Lift ban", `Restore access for ${ban.label}?`, [
                    { text: "Cancel", style: "cancel" },
                    {
                      text: "Lift ban",
                      onPress: () => {
                        setBusy(true);
                        void liftAccessBan(token, ban.id)
                          .then(load)
                          .catch((caught) => setError(caught instanceof Error ? caught.message : "Could not lift that ban."))
                          .finally(() => setBusy(false));
                      },
                    },
                  ]);
                }}
              />
            </View>
          ))}
          {bans.length === 0 && !error ? <Text style={staffStyles.muted}>No active bans.</Text> : null}
        </ScrollView>
      </SafeAreaView>
    </StaffGate>
  );
}
