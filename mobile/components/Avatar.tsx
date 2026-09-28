import { useEffect, useState } from "react";
import { Image } from "expo-image";
import { StyleSheet, Text, View } from "react-native";
import { displayAvatarSrc } from "@/lib/avatarSrc";
import { publicAppUrl } from "@/lib/supabase";
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
  const [failed, setFailed] = useState(false);
  const src = displayAvatarSrc(uri, publicAppUrl());
  useEffect(() => {
    setFailed(false);
  }, [src]);
  const letter = (name || "P").trim().slice(0, 1).toUpperCase() || "P";
  if (src && !failed) {
    return (
      <Image
        source={{ uri: src }}
        style={[styles.image, { width: size, height: size, borderRadius: size / 2 }]}
        onError={() => setFailed(true)}
      />
    );
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
