import { useEffect } from "react";
import { BackHandler, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

type Panel = "menu" | "visibility" | "delete";

export function PlayerMoreSheet({
  title,
  canManage,
  panel,
  onPanel,
  onShare,
  onSave,
  onVisibility,
  onDelete,
  onClose,
}: {
  title: string;
  canManage: boolean;
  panel: Panel;
  onPanel: (panel: Panel) => void;
  onShare: () => void;
  onSave: () => void;
  onVisibility: (visibility: "public" | "unlisted" | "private") => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();

  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (panel !== "menu") {
        onPanel("menu");
        return true;
      }
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [panel, onClose, onPanel]);

  return (
    <View style={styles.wrap} pointerEvents="box-none">
      <Pressable style={styles.dim} onPress={onClose} accessibilityLabel="Close" />
      <View
        style={[styles.card, { paddingBottom: insets.bottom + 12 }]}
        accessibilityViewIsModal
        accessibilityRole="menu"
        accessibilityLabel={title || "Clip actions"}
      >
        <View style={styles.grip} />
        {panel === "menu" ? (
          <>
            <Text style={styles.heading} numberOfLines={1}>
              {title || "Clip"}
            </Text>
            <Row label="Share" onPress={onShare} />
            <Row label="Save to Photos" onPress={onSave} />
            {canManage ? (
              <>
                <Row label="Visibility" onPress={() => onPanel("visibility")} />
                <Row label="Delete" danger onPress={() => onPanel("delete")} />
              </>
            ) : null}
            <Row label="Cancel" muted onPress={onClose} />
          </>
        ) : null}
        {panel === "visibility" ? (
          <>
            <Text style={styles.heading}>Visibility</Text>
            <Text style={styles.hint}>Unlisted links never include your username.</Text>
            <Row label="Public" onPress={() => onVisibility("public")} />
            <Row label="Unlisted" onPress={() => onVisibility("unlisted")} />
            <Row label="Private" onPress={() => onVisibility("private")} />
            <Row label="Back" muted onPress={() => onPanel("menu")} />
          </>
        ) : null}
        {panel === "delete" ? (
          <>
            <Text style={styles.heading}>Delete this clip?</Text>
            <Text style={styles.hint}>Removes the cloud copy.</Text>
            <Row label="Delete" danger onPress={onDelete} />
            <Row label="Back" muted onPress={() => onPanel("menu")} />
          </>
        ) : null}
      </View>
    </View>
  );
}

function Row({
  label,
  onPress,
  danger,
  muted,
}: {
  label: string;
  onPress: () => void;
  danger?: boolean;
  muted?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={styles.row}
      accessibilityRole="menuitem"
      accessibilityLabel={label}
    >
      <Text style={[styles.rowLabel, danger && styles.danger, muted && styles.muted]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { ...StyleSheet.absoluteFill, justifyContent: "flex-end", zIndex: 8 },
  dim: { ...StyleSheet.absoluteFill, backgroundColor: "#00000066" },
  card: {
    backgroundColor: "#16181f",
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingHorizontal: 8,
    paddingTop: 8,
  },
  grip: {
    alignSelf: "center",
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: "#3a3d46",
    marginBottom: 8,
  },
  heading: { color: "#fff", fontSize: 16, fontWeight: "700", paddingHorizontal: 12, paddingVertical: 8 },
  hint: { color: "#9aa0ab", fontSize: 13, paddingHorizontal: 12, paddingBottom: 8 },
  row: { minHeight: 48, justifyContent: "center", paddingHorizontal: 12, borderRadius: 12 },
  rowLabel: { color: "#fff", fontSize: 16, fontWeight: "600" },
  danger: { color: "#ff6b6b" },
  muted: { color: "#9aa0ab", fontWeight: "500" },
});
