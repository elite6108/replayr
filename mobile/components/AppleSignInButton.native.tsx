import * as AppleAuthentication from "expo-apple-authentication";
import { Platform } from "react-native";
import { Button } from "@/components/ui";
import { getSupabase } from "@/lib/supabase";

export function AppleSignInButton({
  disabled,
  onError,
  onBusy,
}: {
  disabled?: boolean;
  onError: (message: string) => void;
  onBusy?: (busy: boolean) => void;
}) {
  if (Platform.OS !== "ios") return null;

  async function startApple() {
    onBusy?.(true);
    try {
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
    } catch (caught) {
      if (typeof caught === "object" && caught !== null && "code" in caught && (caught as { code?: string }).code === "ERR_REQUEST_CANCELED") {
        return;
      }
      const message = caught instanceof Error ? caught.message : "Could not start social sign-in";
      onError(/provider is not enabled|unsupported provider/i.test(message) ? "That sign-in method is not enabled yet." : message);
    } finally {
      onBusy?.(false);
    }
  }

  return <Button label="Continue with Apple" kind="primary" disabled={disabled} onPress={() => void startApple()} />;
}
