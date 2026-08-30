import { StyleSheet, View } from "react-native";
import { AppleSignInButton } from "@/components/AppleSignInButton";
import { SocialIconButton } from "@/components/SocialIconButton";

type SocialProvider = "google" | "discord" | "twitter";

const PROVIDERS: { id: SocialProvider; label: string; icon?: "logo-google" | "logo-discord"; mark?: string }[] = [
  { id: "google", label: "Continue with Google", icon: "logo-google" },
  { id: "discord", label: "Continue with Discord", icon: "logo-discord" },
  { id: "twitter", label: "Continue with X", mark: "X" },
];

export function SocialAuthRow({
  disabled,
  onProvider,
  onAppleError,
  onAppleBusy,
  onAppleOAuth,
}: {
  disabled?: boolean;
  onProvider: (provider: SocialProvider) => void;
  onAppleError: (message: string) => void;
  onAppleBusy?: (busy: boolean) => void;
  onAppleOAuth?: () => Promise<void>;
}) {
  return (
    <View style={styles.row}>
      <SocialIconButton
        label={PROVIDERS[0].label}
        icon={PROVIDERS[0].icon}
        disabled={disabled}
        onPress={() => onProvider("google")}
      />
      <AppleSignInButton disabled={disabled} onError={onAppleError} onBusy={onAppleBusy} onOAuth={onAppleOAuth} />
      <SocialIconButton
        label={PROVIDERS[1].label}
        icon={PROVIDERS[1].icon}
        disabled={disabled}
        onPress={() => onProvider("discord")}
      />
      <SocialIconButton
        label={PROVIDERS[2].label}
        mark={PROVIDERS[2].mark}
        disabled={disabled}
        onPress={() => onProvider("twitter")}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", justifyContent: "center", gap: 12, flexWrap: "wrap" },
});
