import { useEffect, useState } from "react";
import { Modal, Pressable, Text, View } from "react-native";
import { useVideoPlayer, VideoView } from "expo-video";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ReplayrWatermark } from "@/components/ReplayrWatermark";
import { folderStyles } from "@/components/folders/folderStyles";
import { playFolderMedia } from "@/lib/api.folders";
import { colors } from "@/lib/theme";
import type { FolderClip } from "@/lib/social-types";

export function FolderPlayModal({
  visible,
  token,
  folderId,
  clip,
  onClose,
}: {
  visible: boolean;
  token: string;
  folderId: string;
  clip: FolderClip | null;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible || !clip) {
      setUrl(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setUrl(null);
    setError(null);
    void playFolderMedia(token, folderId, clip)
      .then((next) => {
        if (!cancelled) setUrl(next);
      })
      .catch((caught) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Could not play that clip.");
      });
    return () => {
      cancelled = true;
    };
  }, [clip, folderId, token, visible]);

  return (
    <Modal visible={visible} animationType="fade" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: "#000", paddingTop: insets.top }}>
        <Pressable onPress={onClose} style={{ padding: 16 }}>
          <Text style={{ color: colors.accent, fontWeight: "700" }}>Close</Text>
        </Pressable>
        {error ? <Text style={[folderStyles.error, { paddingHorizontal: 16 }]}>{error}</Text> : null}
        {url ? <FolderVideo url={url} /> : !error ? <Text style={[folderStyles.muted, { padding: 16 }]}>Loading playback…</Text> : null}
        <Text style={[folderStyles.clipTitle, { padding: 16 }]}>{clip?.title || "Clip"}</Text>
      </View>
    </Modal>
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
