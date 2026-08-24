import { useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Redirect, useRouter } from "expo-router";
import * as Linking from "expo-linking";
import * as WebBrowser from "expo-web-browser";
import { AppleSignInButton } from "@/components/AppleSignInButton";
import { Image } from "expo-image";
import { Button, Field, Notice } from "@/components/ui";
import { useAuth } from "@/lib/auth";
import { getSupabase, supabaseConfigured } from "@/lib/supabase";
import { colors } from "@/lib/theme";

type SocialProvider = "google" | "discord" | "twitter";

const PROVIDERS: { id: SocialProvider; label: string }[] = [
  { id: "google", label: "Continue with Google" },
  { id: "discord", label: "Continue with Discord" },
  { id: "twitter", label: "Continue with X" },
];

WebBrowser.maybeCompleteAuthSession();

export default function SignInScreen() {
  const router = useRouter();
  const { session } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"in" | "up">("in");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<ScrollView>(null);

  function revealField() {
    requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }));
  }

  async function startSocial(provider: SocialProvider) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (!supabaseConfigured()) throw new Error("Supabase is not configured.");
      const redirectTo = Linking.createURL("auth/callback");
      const { data, error: next } = await getSupabase().auth.signInWithOAuth({
        provider,
        options: { redirectTo, skipBrowserRedirect: true },
      });
      if (next) throw next;
      if (!data.url) throw new Error("Could not start social sign-in.");
      const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
      if (result.type !== "success") return;
      await finishAuthUrl(result.url);
    } catch (caught) {
      setError(oauthError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function onSubmit() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (!supabaseConfigured()) throw new Error("Supabase is not configured.");
      const auth = getSupabase().auth;
      if (mode === "in") {
        const { error: next } = await auth.signInWithPassword({ email: email.trim(), password });
        if (next) throw next;
      } else {
        const { data, error: next } = await auth.signUp({
          email: email.trim(),
          password,
          options: { emailRedirectTo: "https://www.replayr.tv/auth/callback" },
        });
        if (next) throw next;
        if (!data.session) {
          setNotice("Account created. Confirm the email, then sign in.");
          return;
        }
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not sign in");
    } finally {
      setBusy(false);
    }
  }

  if (session === undefined) {
    return (
      <View style={[styles.flex, styles.page]}>
        <Text style={styles.muted}>Loading…</Text>
      </View>
    );
  }
  if (session) return <Redirect href="/library" />;

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={Platform.OS === "ios" ? 88 : 0}
    >
      <ScrollView
        ref={scrollRef}
        style={styles.flex}
        contentContainerStyle={styles.page}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        automaticallyAdjustKeyboardInsets
      >
        <Image
          source={require("../assets/images/replayr-logo.png")}
          style={styles.brandLogo}
          contentFit="contain"
          accessibilityLabel="Replayr"
        />
        <Text style={styles.title}>{mode === "in" ? "Sign in" : "Create account"}</Text>
        <Text style={styles.muted}>Same Replayr account as the Windows app. Clipping still happens on the PC.</Text>
        <View style={styles.row}>
          <Button label="Sign in" kind={mode === "in" ? "primary" : "default"} onPress={() => setMode("in")} />
          <Button label="Create account" kind={mode === "up" ? "primary" : "default"} onPress={() => setMode("up")} />
        </View>
        <AppleSignInButton
          disabled={busy}
          onError={setError}
          onBusy={(next) => {
            setBusy(next);
            if (next) {
              setError(null);
              setNotice(null);
            }
          }}
        />
        {PROVIDERS.map((provider) => (
          <Button key={provider.id} label={provider.label} disabled={busy} onPress={() => void startSocial(provider.id)} />
        ))}
        <Text style={styles.muted}>or email</Text>
        <Field
          label="Email"
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          keyboardType="email-address"
          autoComplete="email"
          onFocus={revealField}
        />
        <Field
          label="Password"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoComplete={mode === "in" ? "current-password" : "new-password"}
          onFocus={revealField}
        />
        <Notice tone="danger">{error}</Notice>
        <Notice>{notice}</Notice>
        <Button
          label={busy ? "Working…" : mode === "in" ? "Sign in" : "Create account"}
          kind="primary"
          disabled={busy}
          onPress={() => void onSubmit()}
        />
        <Button label="Back" onPress={() => router.back()} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

async function finishAuthUrl(url: string) {
  const params = authParams(url);
  if (params.error) throw new Error(params.error);
  if (!params.code) throw new Error("Could not finish social sign-in.");
  const { error } = await getSupabase().auth.exchangeCodeForSession(params.code);
  if (error) throw error;
}

export function authParams(url: string) {
  const normalized = url.replace("#", "?");
  try {
    const parsed = new URL(normalized);
    return {
      code: parsed.searchParams.get("code"),
      error: parsed.searchParams.get("error_description") || parsed.searchParams.get("error"),
    };
  } catch {
    const code = /[?&]code=([^&]+)/.exec(normalized)?.[1] ?? null;
    const error = /[?&]error_description=([^&]+)/.exec(normalized)?.[1] ?? /[?&]error=([^&]+)/.exec(normalized)?.[1] ?? null;
    return { code: code ? decodeURIComponent(code) : null, error: error ? decodeURIComponent(error) : null };
  }
}

function oauthError(caught: unknown): string {
  const message = caught instanceof Error ? caught.message : "Could not start social sign-in";
  if (/provider is not enabled|unsupported provider/i.test(message)) {
    return "That sign-in method is not enabled yet.";
  }
  return message;
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  page: { flexGrow: 1, backgroundColor: colors.bg, padding: 16, paddingBottom: 32, gap: 12 },
  brandLogo: { width: 168, height: 46, marginBottom: 8 },
  title: { color: colors.text, fontSize: 28, fontWeight: "700" },
  muted: { color: colors.muted, fontSize: 14, lineHeight: 20 },
  row: { flexDirection: "row", gap: 8 },
});
