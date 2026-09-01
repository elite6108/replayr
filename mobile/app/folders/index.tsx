import { useCallback, useMemo, useState } from "react";
import { Alert, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { AppHeader } from "@/components/AppHeader";
import { FolderCard } from "@/components/folders/FolderCard";
import { folderStyles } from "@/components/folders/folderStyles";
import { Button, Notice } from "@/components/ui";
import {
  acceptFolderInvite,
  createFolder,
  deleteFolderInvite,
  folderRoleLabel,
  listFolders,
  listIncomingFolderInvites,
  folderHref,
  listSharedFolders,
} from "@/lib/api.folders";
import { useAuth } from "@/lib/auth";
import type { Folder, FolderInvite } from "@/lib/social-types";

export default function FoldersScreen() {
  const router = useRouter();
  const { session } = useAuth();
  const token = session?.access_token;
  const [mine, setMine] = useState<Folder[]>([]);
  const [shared, setShared] = useState<Folder[]>([]);
  const [invites, setInvites] = useState<FolderInvite[]>([]);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"updated" | "name">("updated");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!token) return;
    setError(null);
    const [mineResult, sharedResult, inviteResult] = await Promise.allSettled([
      listFolders(token),
      listSharedFolders(token),
      listIncomingFolderInvites(token),
    ]);
    if (mineResult.status === "fulfilled") setMine(mineResult.value);
    if (sharedResult.status === "fulfilled") setShared(sharedResult.value);
    if (inviteResult.status === "fulfilled") setInvites(inviteResult.value);
    if (mineResult.status === "rejected") {
      setError(mineResult.reason instanceof Error ? mineResult.reason.message : "Could not load folders.");
    }
    setLoading(false);
  }, [token]);

  useFocusEffect(
    useCallback(() => {
      if (!session) {
        setLoading(false);
        return;
      }
      void load();
    }, [load, session]),
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

  if (session === undefined) {
    return (
      <View style={folderStyles.center}>
        <Text style={folderStyles.muted}>Loading…</Text>
      </View>
    );
  }

  if (!session) {
    return (
      <View style={folderStyles.center}>
        <Text style={folderStyles.title}>Folders</Text>
        <Text style={folderStyles.muted}>Sign in with the same Replayr account as the Windows app.</Text>
        <Button label="Sign in" kind="primary" onPress={() => router.push("/signin")} />
      </View>
    );
  }

  return (
    <SafeAreaView style={folderStyles.page} edges={["top"]}>
      <AppHeader padded />
      <View style={folderStyles.tabs}>
        <Pressable onPress={() => router.replace("/library")}>
          <Text style={folderStyles.tab}>Clips</Text>
        </Pressable>
        <Text style={[folderStyles.tab, folderStyles.tabOn]}>Folders</Text>
      </View>
      <ScrollView contentContainerStyle={folderStyles.scroll}>
        <Text style={folderStyles.title}>Folders</Text>
        <Text style={folderStyles.muted}>Create a folder to organize and share your best clips.</Text>
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="New folder name"
          placeholderTextColor="#8b93a1"
          style={folderStyles.input}
          maxLength={80}
        />
        <Button
          label={busy ? "Creating…" : "Create folder"}
          kind="primary"
          disabled={!name.trim() || busy}
          onPress={() => {
            if (!token || !name.trim()) return;
            setBusy(true);
            void createFolder(token, { name: name.trim() })
              .then((folder) => {
                setName("");
                setMine((current) => [folder, ...current.filter((item) => item.id !== folder.id)]);
                router.push(folderHref(folder.id));
              })
              .catch((caught) => setError(caught instanceof Error ? caught.message : "Could not create that folder."))
              .finally(() => setBusy(false));
          }}
        />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search folders"
          placeholderTextColor="#8b93a1"
          style={folderStyles.input}
        />
        <Pressable onPress={() => setSort((current) => (current === "updated" ? "name" : "updated"))}>
          <Text style={folderStyles.muted}>Sort: {sort === "updated" ? "Recently updated" : "Name"}</Text>
        </Pressable>

        <Text style={folderStyles.sectionTitle}>Invites</Text>
        {invites.length === 0 && !loading ? (
          <Text style={folderStyles.muted}>No pending folder invites.</Text>
        ) : (
          invites.map((invite) => (
            <View key={invite.id} style={folderStyles.card}>
              <View style={folderStyles.cardBody}>
                <Text style={folderStyles.cardName}>{invite.folderName || "Folder invite"}</Text>
                <Text style={folderStyles.muted}>
                  {invite.inviter.displayName} invited you as {folderRoleLabel(invite.role)}
                </Text>
                <View style={folderStyles.row}>
                  <Button
                    label="Accept"
                    kind="primary"
                    onPress={() => {
                      if (!token) return;
                      void acceptFolderInvite(token, invite.folderId, invite.id).then((folder) => {
                        router.push(folderHref(folder.id));
                      });
                    }}
                  />
                  <Button
                    label="Decline"
                    onPress={() => {
                      if (!token) return;
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
                  />
                </View>
              </View>
            </View>
          ))
        )}

        <Text style={folderStyles.sectionTitle}>My Folders</Text>
        {visibleMine.length === 0 && !loading ? (
          <Text style={folderStyles.muted}>Create a folder to organize and share your best clips.</Text>
        ) : (
          visibleMine.map((folder) => (
            <FolderCard key={folder.id} folder={folder} onPress={() => router.push(folderHref(folder.id))} />
          ))
        )}

        <Text style={folderStyles.sectionTitle}>Shared with Me</Text>
        {visibleShared.length === 0 && !loading ? (
          <Text style={folderStyles.muted}>Folders shared with you will appear here.</Text>
        ) : (
          visibleShared.map((folder) => (
            <FolderCard key={folder.id} folder={folder} onPress={() => router.push(folderHref(folder.id))} />
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
