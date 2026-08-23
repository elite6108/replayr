import { Image } from "expo-image";
import { StyleSheet, Text, View } from "react-native";
import { colors } from "@/lib/theme";

export function GameCover({
  name,
  coverUrl,
  round = false,
  size,
}: {
  name: string;
  coverUrl: string | null;
  round?: boolean;
  size?: number;
}) {
  const shape = [
    styles.cover,
    round && styles.round,
    size ? { width: size, height: size, aspectRatio: 1 } : null,
  ];
  if (coverUrl) {
    return <Image source={{ uri: coverUrl }} style={shape} contentFit="cover" />;
  }
  return (
    <View style={[shape, styles.fallback]}>
      <Text style={styles.letter}>{name.slice(0, 1).toUpperCase()}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  cover: { width: "100%", aspectRatio: 3 / 4, borderRadius: 10, backgroundColor: "#000" },
  round: { aspectRatio: 1, borderRadius: 999 },
  fallback: { alignItems: "center", justifyContent: "center", backgroundColor: colors.raised },
  letter: { color: colors.text, fontSize: 28, fontWeight: "700" },
});
