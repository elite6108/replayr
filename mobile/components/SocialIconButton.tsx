import { Pressable, StyleSheet, Text } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { colors } from "@/lib/theme";

export function SocialIconButton({
  label,
  icon,
  mark,
  disabled,
  onPress,
}: {
  label: string;
  icon?: keyof typeof Ionicons.glyphMap;
  mark?: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  const short = label.replace(/^Continue with /, "");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.btn, pressed && styles.pressed, disabled && styles.disabled]}
    >
      {icon ? <Ionicons name={icon} size={22} color={colors.text} /> : <Text style={styles.mark}>{mark}</Text>}
      <Text style={styles.caption}>{short}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: {
    minWidth: 76,
    borderRadius: 16,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 10,
    paddingHorizontal: 12,
    gap: 4,
  },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.45 },
  mark: { color: colors.text, fontSize: 18, fontWeight: "800" },
  caption: { color: colors.text, fontSize: 12, fontWeight: "600" },
});
