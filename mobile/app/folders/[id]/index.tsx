import { useCallback, useState } from "react";
import { Alert, Pressable, ScrollView, Text, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { AppHeader } from "@/components/AppHeader";
import { Avatar } from "@/components/Avatar";
import { ClipThumb } from "@/components/ClipThumb";
import { FolderActivitySheet } from "@/components/folders/FolderActivitySheet";
import { FolderAddClipsSheet } from "@/components/folders/FolderAddClipsSheet";
import { FolderEditsSheet } from "@/components/folders/FolderEditsSheet";
import { FolderPlayModal } from "@/components/folders/FolderPlayModal";
import { FolderSettingsSheet } from "@/components/folders/FolderSettingsSheet";
import { FolderShareSheet } from "@/components/folders/FolderShareSheet";
import { folderStyles } from "@/components/folders/folderStyles";
import { Button, Notice } from "@/components/ui";
import {
  folderAccessLabel,
  folderRoleLabel,
  foldersHref,
  getFolder,
  removeFolderClip,
} from "@/lib/api.folders";
import { useAuth } from "@/lib/auth";
import { formatClipDate } from "@/lib/format";
import { colors } from "@/lib/theme";
import type { FolderClip, FolderDetail } from "@/lib/social-types";

export default function FolderDetailScreen() {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const id = (Array.isArray(params.id) ? params.id[0] : params.id)?.trim() ?? "";
  const router = useRouter();
  const { session } = useAuth();
  const token = session?.access_token;
  const [folder, setFolder] = useState<FolderDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [editClip, setEditClip] = useState<FolderClip | null>(null);
  const [playing, setPlaying] = useState<FolderClip | null>(null);

  const load = useCallback(async () => {
    if (!token || !id) return;
    try {
      setFolder(await getFolder(token, id));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That folder was not found.");
    }
  }, [id, token]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  function play(clip: FolderClip) {
    if (clip.status !== "ready") {
      setError("That clip is still processing and is not ready to play.");
      return;
    }
    setError(null);
    setPlaying(clip);
  }

  const permissions = folder?.permissions;
  const canAdd = Boolean(permissions?.addClips || folder?.role === "owner" || folder?.role === "manager" || folder?.role === "editor");

  return (
    <SafeAreaView style={folderStyles.page} edges={["top"]}>
      <AppHeader padded />
      <ScrollView contentContainerStyle={folderStyles.scroll}>
        <Pressable onPress={() => router.replace(foldersHref())}>
          <Text style={{ color: "#7fd0ef", fontWeight: "700" }}>Folders</Text>
        </Pressable>
        {error ? <Notice tone="danger">{error}</Notice> : null}
        {notice ? <Notice tone="ok">{notice}</Notice> : null}
        {!folder ? (
          <Text style={folderStyles.muted}>{error ? "This folder is not available." : "Loading folder…"}</Text>
        ) : (
          <>
            <View style={folderStyles.titleRow}>
              <Text style={folderStyles.title}>{folder.name}</Text>
              <Pressable
                style={folderStyles.gear}
                onPress={() => setSettingsOpen(true)}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Folder settings"
              >
                <Ionicons name="settings-outline" size={20} color={colors.text} />
              </Pressable>
            </View>
            {folder.description ? <Text style={folderStyles.muted}>{folder.description}</Text> : null}
            <View style={folderStyles.row}>
              <View style={folderStyles.badge}>
                <Text style={folderStyles.badgeText}>{folderAccessLabel(folder)}</Text>
              </View>
              {folder.role !== "owner" && folder.role !== "public" ? (
                <View style={folderStyles.badge}>
                  <Text style={folderStyles.badgeText}>{folderRoleLabel(folder.role)}</Text>
                </View>
              ) : null}
              <Text style={folderStyles.muted}>
                {folder.clipCount === 1 ? "1 clip" : `${folder.clipCount} clips`}
              </Text>
            </View>
            <View style={folderStyles.avatarRow}>
              {folder.owner ? (
                <Avatar name={folder.owner.displayName} uri={folder.owner.avatarUrl} size={28} />
              ) : null}
              {(folder.membersPreview ?? []).map((person) => (
                <Avatar key={person.id} name={person.displayName} uri={person.avatarUrl} size={28} />
              ))}
            </View>
            <View style={folderStyles.row}>
              {canAdd ? <Button label="Add Clips" kind="primary" onPress={() => setAddOpen(true)} /> : null}
              <Button label="Activity" onPress={() => setActivityOpen(true)} />
            </View>

            {(folder.clips ?? []).length === 0 ? (
              <Text style={folderStyles.muted}>Add clips to start building this folder.</Text>
            ) : (
              folder.clips.map((clip) => (
                <View key={clip.id} style={folderStyles.clipCard}>
                  <Pressable onPress={() => play(clip)}>
                    <ClipThumb title={clip.title || "Clip"} thumbnailUrl={clip.thumbnailUrl} radius={0} />
                  </Pressable>
                  <View style={folderStyles.clipMeta}>
                    <Text style={folderStyles.clipTitle}>{clip.title || "Untitled clip"}</Text>
                    <Text style={folderStyles.muted}>{formatClipDate(clip.createdAt || clip.addedAt)}</Text>
                    <View style={folderStyles.row}>
                      <View style={folderStyles.badge}>
                        <Text style={folderStyles.badgeText}>
                          {clip.kind === "render" ? "Rendered Copy" : "Original"}
                        </Text>
                      </View>
                    </View>
                    <View style={folderStyles.row}>
                      <Button label="Play" onPress={() => play(clip)} />
                      {clip.visibility === "public" || clip.visibility === "unlisted" ? (
                        <Button label="Open Original" onPress={() => router.push(`/c/${clip.slug}`)} />
                      ) : (
                        <Button label="Open Original" onPress={() => play(clip)} />
                      )}
                      {permissions?.viewEdits ? (
                        <Button
                          label={permissions.createEdits ? "Edits" : "View Edits"}
                          onPress={() => setEditClip(clip)}
                        />
                      ) : null}
                      {permissions?.removeClips ? (
                        <Button
                          label="Remove from Folder"
                          onPress={() =>
                            Alert.alert(
                              "Remove from folder?",
                              "The original clip stays in the owner's library. This does not delete the clip.",
                              [
                                { text: "Cancel", style: "cancel" },
                                {
                                  text: "Remove from Folder",
                                  style: "destructive",
                                  onPress: () => {
                                    if (!token) return;
                                    void removeFolderClip(token, folder.id, clip.id).then(() => load());
                                  },
                                },
                              ],
                            )
                          }
                        />
                      ) : null}
                    </View>
                  </View>
                </View>
              ))
            )}
          </>
        )}
      </ScrollView>
      {folder && token ? (
        <>
          <FolderSettingsSheet
            visible={settingsOpen}
            token={token}
            folder={folder}
            onClose={() => setSettingsOpen(false)}
            onFolder={setFolder}
            onDeleted={() => router.replace(foldersHref())}
            onPeople={() => setShareOpen(true)}
            onError={setError}
          />
          <FolderShareSheet
            visible={shareOpen}
            token={token}
            folder={folder}
            onClose={() => setShareOpen(false)}
            onFolder={setFolder}
            onError={setError}
          />
          <FolderAddClipsSheet
            visible={addOpen}
            token={token}
            folder={folder}
            onClose={() => setAddOpen(false)}
            onAdded={(next) => {
              setFolder(next);
              setNotice(
                next.clips.length
                  ? `Folder now has ${next.clips.length} clip${next.clips.length === 1 ? "" : "s"}.`
                  : "Clips added.",
              );
              void load();
            }}
            onError={setError}
          />
          <FolderActivitySheet
            visible={activityOpen}
            token={token}
            folderId={folder.id}
            onClose={() => setActivityOpen(false)}
          />
          <FolderPlayModal
            visible={Boolean(playing)}
            token={token}
            folderId={folder.id}
            clip={playing}
            onClose={() => setPlaying(null)}
          />
          {editClip ? (
            <FolderEditsSheet
              visible
              token={token}
              folder={folder}
              clip={editClip}
              onClose={() => setEditClip(null)}
              onNotice={setNotice}
              onError={setError}
              onRefresh={load}
            />
          ) : null}
        </>
      ) : null}
    </SafeAreaView>
  );
}
