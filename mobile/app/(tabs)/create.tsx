import { Pressable, StyleSheet, Text, View } from "react-native";
import * as Linking from "expo-linking";
import { SafeAreaView } from "react-native-safe-area-context";
import { colors } from "@/lib/theme";

export default function CreateScreen() {
  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.card}>
        <Text style={styles.title}>Clip on Windows</Text>
        <Text style={styles.copy}>
          Replayr records on the desktop app. Capture there, then your clips show up in Clips and For You.
        </Text>
        <Pressable onPress={() => void Linking.openURL("https://www.replayr.tv")}>
          <Text style={styles.link}>Get Replayr for Windows</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg, padding: 20, justifyContent: "center" },
  card: {
    backgroundColor: colors.card,
    borderRadius: 20,
    padding: 22,
    gap: 12,
    borderWidth: 1,
    borderColor: colors.border,
  },
  title: { color: colors.text, fontSize: 24, fontWeight: "800" },
  copy: { color: colors.muted, fontSize: 15, lineHeight: 22 },
  link: { color: colors.accent, fontWeight: "700", fontSize: 16 },
});
