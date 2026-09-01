import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { Avatar } from "@/components/Avatar";
import { FolderSheetFrame } from "@/components/folders/FolderSheetFrame";
import { folderStyles } from "@/components/folders/folderStyles";
import { listFolderActivity } from "@/lib/api.folders";
import type { FolderActivity } from "@/lib/social-types";

export function FolderActivitySheet({
  visible,
  token,
  folderId,
  onClose,
}: {
  visible: boolean;
  token: string;
  folderId: string;
  onClose: () => void;
}) {
  const [items, setItems] = useState<FolderActivity[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    void listFolderActivity(token, folderId)
      .then(setItems)
      .catch((caught) => setError(caught instanceof Error ? caught.message : "Could not load folder activity."));
  }, [folderId, token, visible]);

  return (
    <FolderSheetFrame visible={visible} title="Activity" onClose={onClose}>
      <Text style={folderStyles.muted}>Only people with access see this. Autosaves are not listed.</Text>
      {error ? <Text style={folderStyles.error}>{error}</Text> : null}
      {items.length === 0 && !error ? <Text style={folderStyles.muted}>No folder activity yet.</Text> : null}
      {items.map((item) => (
        <View key={item.id} style={folderStyles.memberRow}>
          <Avatar name={item.actor.displayName} uri={item.actor.avatarUrl} size={28} />
          <View style={folderStyles.memberMain}>
            <Text style={folderStyles.memberName}>{item.summary}</Text>
            <Text style={folderStyles.muted}>{new Date(item.createdAt).toLocaleString()}</Text>
          </View>
        </View>
      ))}
    </FolderSheetFrame>
  );
}
