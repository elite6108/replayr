import { Image } from "expo-image";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Ionicons from "@expo/vector-icons/Ionicons";
import { fetchPublicScreenshot, type PublicScreenshot } from "@/lib/api";
import { saveScreenshotToPhotos, shareClipUrl } from "@/lib/media";
import { screenshotImageUrl, screenshotShareUrl } from "@/lib/supabase";
import { colors } from "@/lib/theme";

function firstParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

export default function ScreenshotScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ slug?: string | string[] }>();
  const slug = firstParam(params.slug).replace(/\.png$/i, "");
  const [shot, setShot] = useState<PublicScreenshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetchPublicScreenshot(slug)
      .then((next) => {
        if (!cancelled) setShot(next);
      })
      .catch((caught) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Screenshot unavailable");
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  async function save() {
    setBusy(true);
    try {
      await saveScreenshotToPhotos(slug);
      Alert.alert("Saved", "The screenshot is in your photo library.");
    } catch (caught) {
      Alert.alert("Could not save", caught instanceof Error ? caught.message : "Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={styles.page} edges={["top", "bottom"]}>
      <View style={styles.bar}>
        <Pressable onPress={() => router.back()} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close">
          <Ionicons name="close" size={28} color={colors.text} />
        </Pressable>
        <Text style={styles.title}>{shot ? `${shot.width}×${shot.height}` : "Screenshot"}</Text>
        <View style={styles.actions}>
          <Pressable
            onPress={() => void shareClipUrl(screenshotShareUrl(slug))}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Share"
          >
            <Ionicons name="share-outline" size={24} color={colors.text} />
          </Pressable>
          <Pressable
            onPress={() => void save()}
            disabled={busy || !shot}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Save"
          >
            <Ionicons name="download-outline" size={24} color={busy ? colors.muted : colors.text} />
          </Pressable>
        </View>
      </View>
      {error ? (
        <Text style={styles.error}>{error}</Text>
      ) : (
        <Image source={{ uri: screenshotImageUrl(slug) }} style={styles.image} contentFit="contain" />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: "#000" },
  bar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  title: { color: colors.text, fontSize: 16, fontWeight: "700" },
  actions: { flexDirection: "row", gap: 16, minWidth: 64, justifyContent: "flex-end" },
  image: { flex: 1, width: "100%" },
  error: { color: colors.danger, padding: 24, textAlign: "center" },
});
