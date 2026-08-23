import { Image } from "expo-image";
import { StyleSheet, Text, View } from "react-native";
import { colors } from "@/lib/theme";

export function Avatar({
  name,
  uri,
  size = 32,
}: {
  name?: string | null;
  uri?: string | null;
  size?: number;
}) {
  const letter = (name || "P").trim().slice(0, 1).toUpperCase() || "P";
  if (uri) {
    return <Image source={{ uri }} style={[styles.image, { width: size, height: size, borderRadius: size / 2 }]} />;
  }
  return (
    <View style={[styles.fallback, { width: size, height: size, borderRadius: size / 2 }]}>
      <Text style={[styles.letter, { fontSize: Math.max(12, size * 0.4) }]}>{letter}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  image: { backgroundColor: "#222" },
  fallback: { alignItems: "center", justifyContent: "center", backgroundColor: colors.raised },
  letter: { color: colors.text, fontWeight: "700" },
});
