import { ReactNode } from "react";
import { Pressable, StyleSheet, Text, TextInput, View, type TextInputProps } from "react-native";
import { colors } from "@/lib/theme";

export function Button({
  label,
  onPress,
  disabled,
  kind = "default",
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  kind?: "default" | "primary" | "danger";
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={[styles.btn, kind === "primary" && styles.primary, kind === "danger" && styles.danger, disabled && styles.disabled]}
    >
      <Text style={[styles.btnText, kind === "primary" && styles.primaryText]}>{label}</Text>
    </Pressable>
  );
}

export function Field({
  label,
  ...props
}: TextInputProps & { label: string }) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        placeholderTextColor={colors.muted}
        style={styles.input}
        {...props}
      />
    </View>
  );
}

export function Notice({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "ok" | "danger" }) {
  if (!children) return null;
  return (
    <Text style={[styles.notice, tone === "ok" && styles.ok, tone === "danger" && styles.err]}>
      {children}
    </Text>
  );
}

const styles = StyleSheet.create({
  btn: {
    backgroundColor: colors.raised,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
    alignItems: "center",
  },
  primary: {
    backgroundColor: "#ffffff",
    borderColor: "#ffffff",
    borderRadius: 22,
  },
  danger: { borderColor: colors.danger },
  disabled: { opacity: 0.5 },
  btnText: { color: colors.text, fontWeight: "600" },
  primaryText: { color: "#07080b" },
  field: { gap: 6 },
  label: { color: colors.muted, fontSize: 13 },
  input: {
    backgroundColor: colors.raised,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    color: colors.text,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
  },
  notice: { color: colors.muted, fontSize: 14 },
  ok: { color: colors.ok },
  err: { color: colors.danger },
});
