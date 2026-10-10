import { Pressable, StyleSheet, Text, View } from "react-native";
import { Avatar } from "@/components/Avatar";
import { ClipThumb } from "@/components/ClipThumb";
import { folderAccessLabel, folderRoleLabel } from "@/lib/api.folders";
import { formatClipDate } from "@/lib/format";
import type { Folder } from "@/lib/social-types";
import { colors } from "@/lib/theme";

export function FolderCard({
  folder,
  width,
  onPress,
}: {
  folder: Folder;
  width: number;
  onPress: () => void;
}) {
  const shared = folder.role !== "owner" && folder.role !== "public";
  return (
    <Pressable
      style={({ pressed }) => [styles.card, { width }, pressed && styles.pressed]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Open ${folder.name}`}
    >
      <View style={styles.cover}>
        <ClipThumb title={folder.name} thumbnailUrl={folder.coverThumbnailUrl} aspectRatio={1.18} radius={10} />
        <View style={styles.accessBadge}>
          <Text style={styles.accessText} numberOfLines={1}>
            {folderAccessLabel(folder)}
          </Text>
        </View>
      </View>
      <View style={styles.body}>
        <Text style={styles.name} numberOfLines={1}>
          {folder.name}
        </Text>
        <Text style={styles.meta} numberOfLines={1}>
          {folder.clipCount === 1 ? "1 clip" : `${folder.clipCount} clips`}
          {folder.updatedAt || folder.createdAt ? ` · ${formatClipDate(folder.updatedAt || folder.createdAt)}` : ""}
        </Text>
        <View style={styles.footer}>
          {shared ? (
            <View style={styles.roleBadge}>
              <Text style={styles.roleText} numberOfLines={1}>
                {folderRoleLabel(folder.role)}
              </Text>
            </View>
          ) : (
            <Text style={styles.ownerText}>Your folder</Text>
          )}
          {(folder.membersPreview ?? []).length > 0 ? (
            <View style={styles.avatarRow}>
              {folder.membersPreview.slice(0, 3).map((person, index) => (
                <View key={person.id} style={[styles.avatar, index > 0 && styles.avatarOverlap]}>
                  <Avatar name={person.displayName} uri={person.avatarUrl} size={18} />
                </View>
              ))}
            </View>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.raised,
    padding: 5,
    gap: 7,
  },
  pressed: { opacity: 0.76 },
  cover: { position: "relative" },
  accessBadge: {
    position: "absolute",
    top: 6,
    right: 6,
    maxWidth: "75%",
    minHeight: 20,
    borderRadius: 10,
    paddingHorizontal: 7,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(5, 8, 13, 0.78)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.18)",
  },
  accessText: { color: colors.text, fontSize: 8, fontWeight: "800" },
  body: { paddingHorizontal: 4, paddingBottom: 4, gap: 3 },
  name: { color: colors.text, fontSize: 11, fontWeight: "800" },
  meta: { color: colors.muted, fontSize: 9 },
  footer: {
    minHeight: 19,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 5,
  },
  roleBadge: {
    flexShrink: 1,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.chrome,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  roleText: { color: colors.text, fontSize: 8, fontWeight: "700" },
  ownerText: { color: colors.muted, fontSize: 8, fontWeight: "700" },
  avatarRow: { flexDirection: "row", alignItems: "center", paddingRight: 1 },
  avatar: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.raised,
    overflow: "hidden",
  },
  avatarOverlap: { marginLeft: -5 },
});
