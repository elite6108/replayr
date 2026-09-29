import { Pressable, Text, View } from "react-native";
import { staffStyles } from "@/components/staff/staffStyles";

export function StaffTaskHeader({
  boardName,
  columnName,
  saveState,
  canMove,
  onBack,
  onStatus,
}: {
  boardName: string | null;
  columnName: string;
  saveState: "idle" | "saving" | "saved";
  canMove: boolean;
  onBack: () => void;
  onStatus: () => void;
}) {
  return (
    <View style={{ gap: 8 }}>
      <Pressable onPress={onBack}>
        <Text style={staffStyles.back}>Back</Text>
      </Pressable>
      <View style={staffStyles.titleRow}>
        <View style={{ flex: 1, gap: 4 }}>
          <Text style={staffStyles.eyebrow}>Task details</Text>
          {boardName ? <Text style={staffStyles.muted}>{boardName}</Text> : null}
        </View>
        {saveState !== "idle" ? (
          <Text style={staffStyles.saveHint}>{saveState === "saving" ? "Saving…" : "Saved"}</Text>
        ) : null}
        <Pressable style={staffStyles.pill} onPress={onStatus} disabled={!canMove}>
          <Text style={staffStyles.pillTextOn}>{columnName}</Text>
        </Pressable>
      </View>
    </View>
  );
}
