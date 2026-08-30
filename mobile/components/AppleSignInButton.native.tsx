import * as AppleAuthentication from "expo-apple-authentication";
import { Platform } from "react-native";
import { SocialIconButton } from "@/components/SocialIconButton";
import { getSupabase } from "@/lib/supabase";

export function AppleSignInButton({
  disabled,
  onError,
  onBusy,
  onOAuth,
}: {
  disabled?: boolean;
  onError: (message: string) => void;
  onBusy?: (busy: boolean) => void;
  onOAuth?: () => Promise<void>;
}) {
  if (Platform.OS !== "ios") return null;

  async function startApple() {
    onBusy?.(true);
    try {
      if (await nativeAppleAvailable()) {
        const credential = await AppleAuthentication.signInAsync({
          requestedScopes: [
            AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
            AppleAuthentication.AppleAuthenticationScope.EMAIL,
          ],
        });
        if (!credential.identityToken) throw new Error("Apple did not return an identity token.");
        const { error: next } = await getSupabase().auth.signInWithIdToken({
          provider: "apple",
          token: credential.identityToken,
        });
        if (next) throw next;
        return;
      }
      if (onOAuth) {
        await onOAuth();
        return;
      }
      throw new Error("Sign in with Apple needs a Replayr development build on this device.");
    } catch (caught) {
      if (isCanceled(caught)) return;
      if (isNativeMissing(caught) && onOAuth) {
        await onOAuth();
        return;
      }
      const message = caught instanceof Error ? caught.message : "Could not start social sign-in";
      onError(/provider is not enabled|unsupported provider/i.test(message) ? "That sign-in method is not enabled yet." : message);
    } finally {
      onBusy?.(false);
    }
  }

  return (
    <SocialIconButton label="Continue with Apple" icon="logo-apple" disabled={disabled} onPress={() => void startApple()} />
  );
}

async function nativeAppleAvailable() {
  try {
    return await AppleAuthentication.isAvailableAsync();
  } catch {
    return false;
  }
}

function isCanceled(caught: unknown) {
  return typeof caught === "object" && caught !== null && "code" in caught && (caught as { code?: string }).code === "ERR_REQUEST_CANCELED";
}

function isNativeMissing(caught: unknown) {
  const message = caught instanceof Error ? caught.message : "";
  return /not available|linked all the native dependencies|UnavailabilityError/i.test(message);
}
