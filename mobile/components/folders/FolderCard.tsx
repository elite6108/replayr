import { Pressable, Text, View } from "react-native";
import { Avatar } from "@/components/Avatar";
import { ClipThumb } from "@/components/ClipThumb";
import { folderStyles } from "@/components/folders/folderStyles";
import { folderAccessLabel, folderRoleLabel } from "@/lib/api.folders";
import { formatClipDate } from "@/lib/format";
import type { Folder } from "@/lib/social-types";

export function FolderCard({ folder, onPress }: { folder: Folder; onPress: () => void }) {
  const shared = folder.role !== "owner" && folder.role !== "public";
  return (
    <Pressable style={folderStyles.card} onPress={onPress}>
      <ClipThumb title={folder.name} thumbnailUrl={folder.coverThumbnailUrl} wide radius={0} />
      <View style={folderStyles.cardBody}>
        <Text style={folderStyles.cardName}>{folder.name}</Text>
        <View style={folderStyles.row}>
          <Text style={folderStyles.muted}>
            {folder.clipCount === 1 ? "1 clip" : `${folder.clipCount} clips`}
            {folder.updatedAt || folder.createdAt
              ? ` · ${formatClipDate(folder.updatedAt || folder.createdAt)}`
              : ""}
          </Text>
          <View style={folderStyles.badge}>
            <Text style={folderStyles.badgeText}>{folderAccessLabel(folder)}</Text>
          </View>
          {shared ? (
            <View style={folderStyles.badge}>
              <Text style={folderStyles.badgeText}>{folderRoleLabel(folder.role)}</Text>
            </View>
          ) : null}
        </View>
        {(folder.membersPreview ?? []).length > 0 ? (
          <View style={folderStyles.avatarRow}>
            {folder.membersPreview.slice(0, 4).map((person) => (
              <Avatar key={person.id} name={person.displayName} uri={person.avatarUrl} size={22} />
            ))}
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}
