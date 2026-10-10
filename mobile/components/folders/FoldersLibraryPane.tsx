import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useState,
} from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useFocusEffect, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FolderCard } from "@/components/folders/FolderCard";
import { Button } from "@/components/ui";
import {
  acceptFolderInvite,
  createFolder,
  deleteFolderInvite,
  folderHref,
  folderRoleLabel,
  listFolders,
  listIncomingFolderInvites,
  listSharedFolders,
} from "@/lib/api.folders";
import type { Folder, FolderInvite } from "@/lib/social-types";
import { colors } from "@/lib/theme";

const GRID_GAP = 10;

export type FolderSort = "updated" | "name";

export type FoldersLibraryPaneHandle = {
  refresh: () => void;
  openCreate: () => void;
  openSort: () => void;
};

export const FoldersLibraryPane = forwardRef<
  FoldersLibraryPaneHandle,
  {
    token: string;
    query?: string;
    onTotalChange?: (total: number) => void;
    onSortChange?: (sort: FolderSort) => void;
  }
>(function FoldersLibraryPane({ token, query = "", onTotalChange, onSortChange }, ref) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const cardWidth = Math.floor((width - 32 - GRID_GAP) / 2);
  const [mine, setMine] = useState<Folder[]>([]);
  const [shared, setShared] = useState<Folder[]>([]);
  const [invites, setInvites] = useState<FolderInvite[]>([]);
  const [sort, setSort] = useState<FolderSort>("updated");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [mineResult, sharedResult, inviteResult] = await Promise.allSettled([
      listFolders(token),
      listSharedFolders(token),
      listIncomingFolderInvites(token),
    ]);

    if (mineResult.status === "fulfilled") setMine(mineResult.value);
    if (sharedResult.status === "fulfilled") setShared(sharedResult.value);
    if (inviteResult.status === "fulfilled") setInvites(inviteResult.value);

    const failed = [mineResult, sharedResult, inviteResult].find((result) => result.status === "rejected");
    if (failed?.status === "rejected") {
      setError(failed.reason instanceof Error ? failed.reason.message : "Could not load folders.");
    }
    setLoading(false);
  }, [token]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  useEffect(() => {
    onTotalChange?.(mine.length + shared.length);
  }, [mine.length, onTotalChange, shared.length]);

  useEffect(() => {
    onSortChange?.(sort);
  }, [onSortChange, sort]);

  useImperativeHandle(
    ref,
    () => ({
      refresh: () => void load(),
      openCreate: () => setCreateOpen(true),
      openSort: () => setSortOpen(true),
    }),
    [load],
  );

  function filterSort(list: Folder[]) {
    const needle = query.trim().toLowerCase();
    const filtered = needle ? list.filter((folder) => folder.name.toLowerCase().includes(needle)) : list;
    return [...filtered].sort((a, b) =>
      sort === "name"
        ? a.name.localeCompare(b.name)
        : (b.updatedAt || b.createdAt || "").localeCompare(a.updatedAt || a.createdAt || ""),
    );
  }

  const visibleMine = useMemo(() => filterSort(mine), [mine, query, sort]);
  const visibleShared = useMemo(() => filterSort(shared), [shared, query, sort]);

  function createNewFolder() {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    void createFolder(token, { name: name.trim() })
      .then((folder) => {
        setName("");
        setMine((current) => [folder, ...current.filter((item) => item.id !== folder.id)]);
        setCreateOpen(false);
        router.push(folderHref(folder.id));
      })
      .catch((caught) => setError(caught instanceof Error ? caught.message : "Could not create that folder."))
      .finally(() => setBusy(false));
  }

  return (
    <>
      <ScrollView style={styles.content} contentContainerStyle={styles.scroll}>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {loading ? <ActivityIndicator color={colors.accent} style={styles.loader} /> : null}

        <View style={styles.section}>
          <View style={styles.sectionHead}>
            <Text style={styles.sectionTitle}>Invites</Text>
            <Text style={styles.sectionMeta}>{invites.length} pending</Text>
          </View>
          {invites.length === 0 && !loading ? (
            <Text style={styles.emptyText}>No pending folder invites.</Text>
          ) : (
            invites.map((invite) => (
              <View key={invite.id} style={styles.inviteCard}>
                <View style={styles.inviteIcon}>
                  <Ionicons name="mail-unread-outline" size={19} color={colors.accent} />
                </View>
                <View style={styles.inviteMain}>
                  <Text style={styles.inviteName} numberOfLines={1}>
                    {invite.folderName || "Folder invite"}
                  </Text>
                  <Text style={styles.inviteMeta} numberOfLines={2}>
                    {invite.inviter.displayName} invited you as {folderRoleLabel(invite.role)}
                  </Text>
                </View>
                <View style={styles.inviteActions}>
                  <Pressable
                    style={styles.acceptButton}
                    accessibilityRole="button"
                    accessibilityLabel={`Accept invitation to ${invite.folderName || "folder"}`}
                    onPress={() => {
                      void acceptFolderInvite(token, invite.folderId, invite.id).then((folder) => {
                        router.push(folderHref(folder.id));
                      });
                    }}
                  >
                    <Ionicons name="checkmark" size={16} color={colors.onAccent} />
                  </Pressable>
                  <Pressable
                    style={styles.declineButton}
                    accessibilityRole="button"
                    accessibilityLabel={`Decline invitation to ${invite.folderName || "folder"}`}
                    onPress={() => {
                      Alert.alert("Decline this invite?", undefined, [
                        { text: "Cancel", style: "cancel" },
                        {
                          text: "Decline",
                          style: "destructive",
                          onPress: () => {
                            void deleteFolderInvite(token, invite.folderId, invite.id).then(() => load());
                          },
                        },
                      ]);
                    }}
                  >
                    <Ionicons name="close" size={16} color={colors.text} />
                  </Pressable>
                </View>
              </View>
            ))
          )}
        </View>

        <View style={styles.section}>
          <View style={styles.sectionHead}>
            <Text style={styles.sectionTitle}>My folders</Text>
            <Text style={styles.sectionMeta}>
              {visibleMine.length} folder{visibleMine.length === 1 ? "" : "s"}
            </Text>
          </View>
          {visibleMine.length === 0 && !loading ? (
            <Text style={styles.emptyText}>
              {mine.length > 0 ? "No folders match that search." : "Create a folder to organize and share your best clips."}
            </Text>
          ) : (
            <View style={styles.folderGrid}>
              {visibleMine.map((folder) => (
                <FolderCard
                  key={folder.id}
                  folder={folder}
                  width={cardWidth}
                  onPress={() => router.push(folderHref(folder.id))}
                />
              ))}
            </View>
          )}
        </View>

        <View style={styles.section}>
          <View style={styles.sectionHead}>
            <Text style={styles.sectionTitle}>Shared with me</Text>
            <Text style={styles.sectionMeta}>
              {visibleShared.length} folder{visibleShared.length === 1 ? "" : "s"}
            </Text>
          </View>
          {visibleShared.length === 0 && !loading ? (
            <Text style={styles.emptyText}>
              {shared.length > 0 ? "No shared folders match that search." : "Folders shared with you will appear here."}
            </Text>
          ) : (
            <View style={styles.folderGrid}>
              {visibleShared.map((folder) => (
                <FolderCard
                  key={folder.id}
                  folder={folder}
                  width={cardWidth}
                  onPress={() => router.push(folderHref(folder.id))}
                />
              ))}
            </View>
          )}
        </View>
      </ScrollView>

      <Modal visible={createOpen} transparent animationType="slide" onRequestClose={() => setCreateOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setCreateOpen(false)} />
        <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]}>
          <View style={styles.sheetHandle} />
          <Text style={styles.sheetTitle}>Create a folder</Text>
          <Text style={styles.sheetSub}>Give this folder a memorable name.</Text>
          <TextInput
            value={name}
            onChangeText={setName}
            onSubmitEditing={createNewFolder}
            placeholder="Folder name"
            placeholderTextColor={colors.muted}
            style={styles.createInput}
            maxLength={80}
            returnKeyType="done"
            autoFocus
          />
          <View style={styles.sheetActions}>
            <Button label="Cancel" onPress={() => setCreateOpen(false)} />
            <Button
              label={busy ? "Creating…" : "Create folder"}
              kind="primary"
              disabled={!name.trim() || busy}
              onPress={createNewFolder}
            />
          </View>
        </View>
      </Modal>

      <Modal visible={sortOpen} transparent animationType="slide" onRequestClose={() => setSortOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setSortOpen(false)} />
        <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]}>
          <View style={styles.sheetHandle} />
          <Text style={styles.sheetTitle}>Sort folders</Text>
          <Text style={styles.sheetSub}>Choose how your folders are ordered.</Text>
          {[
            { id: "updated" as const, label: "Recently updated", icon: "time-outline" as const },
            { id: "name" as const, label: "Name", icon: "text-outline" as const },
          ].map((option) => {
            const active = sort === option.id;
            return (
              <Pressable
                key={option.id}
                style={[styles.optionRow, active && styles.optionRowOn]}
                onPress={() => {
                  setSort(option.id);
                  setSortOpen(false);
                }}
              >
                <Ionicons name={option.icon} size={18} color={active ? colors.accent : colors.text} />
                <Text style={[styles.optionText, active && styles.optionTextOn]}>{option.label}</Text>
                {active ? <Ionicons name="checkmark" size={18} color={colors.accent} /> : null}
              </Pressable>
            );
          })}
        </View>
      </Modal>
    </>
  );
});

const styles = StyleSheet.create({
  content: { flex: 1 },
  scroll: { paddingBottom: 112, gap: 18 },
  error: { color: colors.danger, paddingHorizontal: 16, marginBottom: 2 },
  loader: { paddingVertical: 14 },
  section: { gap: 8 },
  sectionHead: {
    minHeight: 28,
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  sectionTitle: { color: colors.text, fontSize: 14, fontWeight: "800" },
  sectionMeta: { color: colors.muted, fontSize: 9 },
  emptyText: { color: colors.muted, fontSize: 11, lineHeight: 16, paddingHorizontal: 16 },
  folderGrid: {
    paddingHorizontal: 16,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: GRID_GAP,
  },
  inviteCard: {
    marginHorizontal: 16,
    minHeight: 64,
    padding: 10,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.raised,
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
  },
  inviteIcon: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.accentDim,
    alignItems: "center",
    justifyContent: "center",
  },
  inviteMain: { flex: 1, gap: 2 },
  inviteName: { color: colors.text, fontSize: 12, fontWeight: "800" },
  inviteMeta: { color: colors.muted, fontSize: 10, lineHeight: 14 },
  inviteActions: { flexDirection: "row", alignItems: "center", gap: 6 },
  acceptButton: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  declineButton: {
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.chrome,
    alignItems: "center",
    justifyContent: "center",
  },
  backdrop: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: "rgba(0,0,0,0.58)",
  },
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.card,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 16,
    paddingTop: 10,
    gap: 10,
  },
  sheetHandle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border,
    alignSelf: "center",
    marginBottom: 2,
  },
  sheetTitle: { color: colors.text, fontSize: 20, fontWeight: "800" },
  sheetSub: { color: colors.muted, fontSize: 12, lineHeight: 17 },
  createInput: {
    minHeight: 46,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.raised,
    color: colors.text,
    paddingHorizontal: 13,
    fontSize: 15,
  },
  sheetActions: { flexDirection: "row", justifyContent: "flex-end", gap: 8 },
  optionRow: {
    minHeight: 46,
    borderRadius: 12,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: colors.raised,
    borderWidth: 1,
    borderColor: colors.border,
  },
  optionRowOn: { borderColor: colors.accentRing, backgroundColor: colors.accentDim },
  optionText: { flex: 1, color: colors.text, fontSize: 13, fontWeight: "700" },
  optionTextOn: { color: colors.accent },
});
