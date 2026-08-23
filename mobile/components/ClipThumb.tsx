import { Image } from "expo-image";
import { StyleSheet, Text, View } from "react-native";
import { colors } from "@/lib/theme";

export function ClipThumb({
  title,
  thumbnailUrl,
  square = false,
  wide = false,
}: {
  title: string;
  thumbnailUrl: string | null;
  square?: boolean;
  wide?: boolean;
}) {
  const shape = [styles.thumb, square && styles.square, wide && styles.wide];
  if (thumbnailUrl) {
    return <Image source={{ uri: thumbnailUrl }} style={shape} contentFit="cover" />;
  }
  return (
    <View style={[shape, styles.fallback]}>
      <Text style={styles.letter}>{title.slice(0, 1).toUpperCase()}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  thumb: { width: "100%", aspectRatio: 16 / 9, backgroundColor: "#111", borderRadius: 6 },
  square: { aspectRatio: 1, borderRadius: 4 },
  wide: { aspectRatio: 16 / 7, borderRadius: 8 },
  fallback: { alignItems: "center", justifyContent: "center", backgroundColor: colors.raised },
  letter: { color: colors.text, fontSize: 28, fontWeight: "700" },
});
