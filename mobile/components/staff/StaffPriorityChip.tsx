import { Text, View } from "react-native";
import { colors } from "@/lib/theme";

const TONE: Record<string, { bg: string; fg: string }> = {
  urgent: { bg: "rgba(227, 107, 107, 0.18)", fg: "#f08a8a" },
  high: { bg: "rgba(245, 158, 11, 0.16)", fg: "#f0c36a" },
  medium: { bg: "rgba(0, 216, 240, 0.14)", fg: colors.accent },
  low: { bg: "rgba(125, 206, 160, 0.14)", fg: colors.ok },
};

export function StaffPriorityChip({ priority }: { priority: string }) {
  if (!priority || priority === "none") return null;
  const tone = TONE[priority] ?? { bg: colors.raised, fg: colors.muted };
  return (
    <View style={{ backgroundColor: tone.bg, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3 }}>
      <Text style={{ color: tone.fg, fontSize: 11, fontWeight: "800", textTransform: "capitalize" }}>{priority}</Text>
    </View>
  );
}
