import { useEffect, useState } from "react";
import { Alert, Text, TextInput } from "react-native";
import { FolderSheetFrame } from "@/components/folders/FolderSheetFrame";
import { folderStyles } from "@/components/folders/folderStyles";
import { Button, Notice } from "@/components/ui";
import { deleteFolder, leaveFolder, updateFolder } from "@/lib/api.folders";
import type { FolderDetail } from "@/lib/social-types";

export function FolderSettingsSheet({
  visible,
  token,
  folder,
  onClose,
  onFolder,
  onDeleted,
  onPeople,
  onError,
}: {
  visible: boolean;
  token: string;
  folder: FolderDetail;
  onClose: () => void;
  onFolder: (folder: FolderDetail) => void;
  onDeleted: () => void;
  onPeople: () => void;
  onError: (value: string | null) => void;
}) {
  const [name, setName] = useState(folder.name);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (visible) {
      setName(folder.name);
      setNotice(null);
    }
  }, [folder.name, visible]);

  const canRename = Boolean(folder.permissions?.manageFolder || folder.role === "owner" || folder.role === "manager");
  const canInvite = Boolean(folder.permissions?.manageMembers || folder.role === "owner" || folder.role === "manager");
  const canDelete = Boolean(folder.permissions?.deleteFolder || folder.role === "owner");

  return (
    <FolderSheetFrame visible={visible} title="Folder settings" onClose={onClose}>
      {notice ? <Notice tone="ok">{notice}</Notice> : null}
      {canRename ? (
        <>
          <Text style={folderStyles.muted}>Name</Text>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="Folder name"
            placeholderTextColor="#8b93a1"
            style={folderStyles.input}
            maxLength={80}
          />
          <Button
            label={busy ? "Saving…" : "Save name"}
            kind="primary"
            disabled={busy || !name.trim() || name.trim() === folder.name}
            onPress={() => {
              const next = name.trim();
              if (!next || next === folder.name) return;
              setBusy(true);
              void updateFolder(token, folder.id, { name: next })
                .then((updated) => {
                  onFolder(updated);
                  setNotice("Folder renamed.");
                })
                .catch((caught) => onError(caught instanceof Error ? caught.message : "Could not rename that folder."))
                .finally(() => setBusy(false));
            }}
          />
        </>
      ) : null}
      <Button
        label={canInvite ? "People & access" : "View people"}
        onPress={() => {
          onClose();
          onPeople();
        }}
      />
      {canDelete ? (
        <Button
          label="Delete folder"
          kind="danger"
          onPress={() =>
            Alert.alert("Delete this folder?", "Clips stay in their owners' libraries. This only removes the folder.", [
              { text: "Cancel", style: "cancel" },
              {
                text: "Delete folder",
                style: "destructive",
                onPress: () => {
                  void deleteFolder(token, folder.id)
                    .then(onDeleted)
                    .catch((caught) =>
                      onError(caught instanceof Error ? caught.message : "Could not delete that folder."),
                    );
                },
              },
            ])
          }
        />
      ) : folder.role !== "owner" ? (
        <Button
          label="Leave folder"
          kind="danger"
          onPress={() =>
            Alert.alert("Leave this folder?", "You will lose access until invited again.", [
              { text: "Cancel", style: "cancel" },
              {
                text: "Leave",
                style: "destructive",
                onPress: () => {
                  void leaveFolder(token, folder.id)
                    .then(onDeleted)
                    .catch((caught) =>
                      onError(caught instanceof Error ? caught.message : "Could not leave that folder."),
                    );
                },
              },
            ])
          }
        />
      ) : null}
    </FolderSheetFrame>
  );
}
