import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useVideoPlayer, VideoView } from "expo-video";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ReplayrWatermark } from "@/components/ReplayrWatermark";
import { folderStyles } from "@/components/folders/folderStyles";
import { folderHref, playFolderMedia } from "@/lib/api.folders";
import { useAuth } from "@/lib/auth";
import { colors } from "@/lib/theme";

function firstParam(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

export default function FolderPlayScreen() {
  const params = useLocalSearchParams<{
    id?: string | string[];
    folderId?: string | string[];
    clipId?: string | string[];
    title?: string | string[];
  }>();
  const folderId = (firstParam(params.folderId) || firstParam(params.id)).trim();
  const clipId = firstParam(params.clipId).trim();
  const title = firstParam(params.title).trim() || "Clip";
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { session } = useAuth();
  const token = session?.access_token;
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token || !folderId || !clipId) {
      if (!folderId || !clipId) setError("That clip could not be opened.");
      return;
    }
    let cancelled = false;
    setError(null);
    void playFolderMedia(token, folderId, { id: clipId, slug: clipId })
      .then((next) => {
        if (!cancelled) setUrl(next);
      })
      .catch((caught) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Could not play that clip.");
      });
    return () => {
      cancelled = true;
    };
  }, [clipId, folderId, token]);

  function close() {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    if (folderId) {
      router.replace(folderHref(folderId));
      return;
    }
    router.replace("/folders");
  }

  return (
    <View style={{ flex: 1, backgroundColor: "#000", paddingTop: insets.top }}>
      <Pressable onPress={close} style={{ padding: 16 }}>
        <Text style={{ color: colors.accent, fontWeight: "700" }}>Close</Text>
      </Pressable>
      {error ? <Text style={[folderStyles.error, { paddingHorizontal: 16 }]}>{error}</Text> : null}
      {url ? <FolderVideo url={url} /> : !error ? <Text style={[folderStyles.muted, { padding: 16 }]}>Loading playback…</Text> : null}
      <Text style={[folderStyles.clipTitle, { padding: 16 }]}>{title}</Text>
    </View>
  );
}

function FolderVideo({ url }: { url: string }) {
  const player = useVideoPlayer(url, (instance) => {
    instance.loop = true;
    instance.play();
  });
  return (
    <View style={{ flex: 1 }}>
      <VideoView player={player} style={{ flex: 1 }} nativeControls contentFit="contain" />
      <ReplayrWatermark show />
    </View>
  );
}
