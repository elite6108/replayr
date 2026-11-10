import { useEffect, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Redirect, useRouter, type Href } from "expo-router";
import * as Linking from "expo-linking";
import * as WebBrowser from "expo-web-browser";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import { SocialAuthRow } from "@/components/SocialAuthRow";
import { Button, Field, Notice } from "@/components/ui";
import { useAuth } from "@/lib/auth";
import { takePendingDeepLink } from "@/lib/pendingDeepLink";
import {
  CONFIRM_EMAIL_MESSAGE,
  EXISTING_ACCOUNT_MESSAGE,
  isAlreadyRegisteredError,
  MOBILE_EMAIL_REDIRECT,
  normalizeAuthEmail,
  signupUserAlreadyExists,
} from "@/lib/signup";
import { getSupabase, supabaseConfigured } from "@/lib/supabase";
import { colors } from "@/lib/theme";

type SocialProvider = "google" | "discord" | "twitter" | "apple";

WebBrowser.maybeCompleteAuthSession();

function PendingRedirect() {
  const [href, setHref] = useState<Href | null>(null);
  useEffect(() => {
    void takePendingDeepLink().then((next) => setHref((next as Href) || "/library"));
  }, []);
  if (!href) {
    return (
      <View style={[styles.flex, styles.page]}>
        <Text style={styles.muted}>Loading…</Text>
      </View>
    );
  }
  return <Redirect href={href} />;
}

export default function SignInScreen() {
  const router = useRouter();
  const { session } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [mode, setMode] = useState<"in" | "up">("in");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const needsAgreement = mode === "up" && !agreed;
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
      const normalized = normalizeAuthEmail(email);
      if (mode === "in") {
        const { error: next } = await auth.signInWithPassword({ email: normalized, password });
        if (next) throw next;
      } else {
        if (password.length < 8) {
          setError("Password must be at least 8 characters.");
          return;
        }
        if (password !== confirm) {
          setError("Passwords do not match.");
          return;
        }
        const { data, error: next } = await auth.signUp({
          email: normalized,
          password,
          options: { emailRedirectTo: MOBILE_EMAIL_REDIRECT },
        });
        if (next) {
          if (isAlreadyRegisteredError(next.message)) {
            setError(EXISTING_ACCOUNT_MESSAGE);
            return;
          }
          throw next;
        }
        if (signupUserAlreadyExists(data.user)) {
          setError(EXISTING_ACCOUNT_MESSAGE);
          return;
        }
        if (!data.session) {
          setNotice(CONFIRM_EMAIL_MESSAGE);
          return;
        }
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not sign in");
    } finally {
      setBusy(false);
    }
  }

  async function onResend() {
    const trimmed = normalizeAuthEmail(email);
    if (!trimmed || !trimmed.includes("@")) {
      setError("Enter your email, then resend the confirmation.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (!supabaseConfigured()) throw new Error("Supabase is not configured.");
      const { error: resendError } = await getSupabase().auth.resend({
        type: "signup",
        email: trimmed,
        options: { emailRedirectTo: MOBILE_EMAIL_REDIRECT },
      });
      if (resendError) throw resendError;
      setNotice("Confirmation email sent. Confirm it, then sign in.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not resend the confirmation email");
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
  if (session) {
    return <PendingRedirect />;
  }

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
          <Button
            label="Sign in"
            kind={mode === "in" ? "primary" : "default"}
            onPress={() => {
              setMode("in");
              setError(null);
              setNotice(null);
            }}
          />
          <Button
            label="Create account"
            kind={mode === "up" ? "primary" : "default"}
            onPress={() => {
              setMode("up");
              setError(null);
              setNotice(null);
            }}
          />
        </View>
        {mode === "up" ? (
          <View style={styles.agreeRow}>
            <Pressable
              accessibilityRole="checkbox"
              accessibilityState={{ checked: agreed }}
              accessibilityLabel="I agree to the Terms and Community Guidelines"
              hitSlop={8}
              onPress={() => setAgreed((value) => !value)}
              style={[styles.agreeBox, agreed && styles.agreeBoxOn]}
            >
              {agreed ? <Ionicons name="checkmark" size={16} color={colors.onAccent} /> : null}
            </Pressable>
            <Text style={styles.agreeText}>
              <Text onPress={() => setAgreed((value) => !value)}>I agree to the </Text>
              <Text style={styles.link} onPress={() => void Linking.openURL("https://www.replayr.tv/terms")}>
                Terms and Community Guidelines
              </Text>
              <Text onPress={() => setAgreed((value) => !value)}> and have read the </Text>
              <Text style={styles.link} onPress={() => void Linking.openURL("https://www.replayr.tv/privacy")}>
                Privacy Policy
              </Text>
              .
            </Text>
          </View>
        ) : null}
        <SocialAuthRow
          disabled={busy || needsAgreement}
          onProvider={(provider) => void startSocial(provider)}
          onAppleError={setError}
          onAppleBusy={(next) => {
            setBusy(next);
            if (next) {
              setError(null);
              setNotice(null);
            }
          }}
          onAppleOAuth={() => startSocial("apple")}
        />
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
        {mode === "up" ? (
          <Field
            label="Confirm password"
            value={confirm}
            onChangeText={setConfirm}
            secureTextEntry
            autoComplete="new-password"
            onFocus={revealField}
          />
        ) : null}
        <Notice tone="danger">{error}</Notice>
        {error === EXISTING_ACCOUNT_MESSAGE ? (
          <Button
            label="Sign in"
            onPress={() => {
              setMode("in");
              setError(null);
            }}
          />
        ) : null}
        <Notice>{notice}</Notice>
        {notice === CONFIRM_EMAIL_MESSAGE ? (
          <Button label="Resend email" disabled={busy || !email.trim()} onPress={() => void onResend()} />
        ) : null}
        <Button
          label={busy ? "Working…" : mode === "in" ? "Sign in" : "Create account"}
          kind="primary"
          disabled={busy || needsAgreement}
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
  agreeRow: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  agreeBox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: colors.muted,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 1,
  },
  agreeBoxOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  agreeText: { flex: 1, color: colors.muted, fontSize: 14, lineHeight: 20 },
  link: { color: colors.accent, textDecorationLine: "underline" },
});
