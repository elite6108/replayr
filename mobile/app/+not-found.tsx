import { StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { Button } from "@/components/ui";
import { colors } from "@/lib/theme";

export default function NotFoundScreen() {
  const router = useRouter();
  return (
    <View style={styles.page}>
      <Text style={styles.title}>This screen doesn't exist.</Text>
      <Button label="Go home" kind="primary" onPress={() => router.replace("/")} />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg, padding: 16, gap: 12, justifyContent: "center" },
  title: { color: colors.text, fontSize: 22, fontWeight: "700" },
});
