import { useEffect, useState } from "react";
import { Image, Pressable, Text, View } from "react-native";
import { FolderSheetFrame } from "@/components/folders/FolderSheetFrame";
import { folderStyles } from "@/components/folders/folderStyles";
import { Button, Notice } from "@/components/ui";
import { fetchLibrary, type ManagedClip } from "@/lib/api";
import { addFolderClips } from "@/lib/api.folders";
import { formatClipDate, formatDurationMs } from "@/lib/format";
import type { FolderDetail } from "@/lib/social-types";

export function FolderAddClipsSheet({
  visible,
  token,
  folder,
  onClose,
  onAdded,
  onError,
}: {
  visible: boolean;
  token: string;
  folder: FolderDetail;
  onClose: () => void;
  onAdded: (folder: FolderDetail) => void;
  onError: (value: string | null) => void;
}) {
  const [clips, setClips] = useState<ManagedClip[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const existing = new Set((folder.clips ?? []).map((clip) => clip.id));

  useEffect(() => {
    if (!visible) return;
    setSelected([]);
    setError(null);
    void fetchLibrary(token, { page: 1, limit: 80 })
      .then((page) => {
        setClips((page.clips ?? []).filter((clip) => clip.status === "ready" && !existing.has(clip.id)));
      })
      .catch((caught) => setError(caught instanceof Error ? caught.message : "Could not load cloud clips."));
  }, [folder.id, token, visible]);

  return (
    <FolderSheetFrame
      visible={visible}
      title="Add clips"
      onClose={onClose}
      footer={
        <Button
          label={busy ? "Adding…" : selected.length ? `Add ${selected.length} clip${selected.length === 1 ? "" : "s"}` : "Add selected"}
          kind="primary"
          disabled={busy || selected.length === 0}
          onPress={() => {
            setBusy(true);
            setError(null);
            void addFolderClips(token, folder.id, { clipIds: selected })
              .then((next) => {
                onAdded(next);
                onClose();
              })
              .catch((caught) => {
                const message = caught instanceof Error ? caught.message : "Could not add those clips.";
                setError(message);
                onError(message);
              })
              .finally(() => setBusy(false));
          }}
        />
      }
    >
      <Text style={folderStyles.muted}>Tap clips to select them, then add. This does not delete originals.</Text>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {clips.length === 0 && !error ? <Text style={folderStyles.muted}>No other cloud clips to add.</Text> : null}
      {clips.map((clip) => {
        const on = selected.includes(clip.id);
        return (
          <Pressable
            key={clip.id}
            style={folderStyles.memberRow}
            onPress={() =>
              setSelected((current) =>
                current.includes(clip.id) ? current.filter((id) => id !== clip.id) : [...current, clip.id],
              )
            }
          >
            {clip.thumbnailUrl ? (
              <Image source={{ uri: clip.thumbnailUrl }} style={{ width: 64, height: 40, borderRadius: 6, backgroundColor: "#111" }} />
            ) : (
              <View style={{ width: 64, height: 40, borderRadius: 6, backgroundColor: "#111", alignItems: "center", justifyContent: "center" }}>
                <Text style={folderStyles.badgeText}>Clip</Text>
              </View>
            )}
            <View style={folderStyles.memberMain}>
              <Text style={folderStyles.memberName}>{clip.title || "Untitled clip"}</Text>
              <Text style={folderStyles.muted}>
                {formatClipDate(clip.createdAt)}
                {clip.durationMs ? ` · ${formatDurationMs(clip.durationMs)}` : ""}
              </Text>
            </View>
            <View style={[folderStyles.badge, on && folderStyles.badgeOn]}>
              <Text style={[folderStyles.badgeText, on && folderStyles.badgeTextOn]}>{on ? "Selected" : "Add"}</Text>
            </View>
          </Pressable>
        );
      })}
    </FolderSheetFrame>
  );
}
