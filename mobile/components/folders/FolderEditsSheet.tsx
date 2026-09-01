import { useEffect, useState } from "react";
import { Alert, Pressable, Text, TextInput, View } from "react-native";
import { FolderSheetFrame } from "@/components/folders/FolderSheetFrame";
import { folderStyles } from "@/components/folders/folderStyles";
import { Button } from "@/components/ui";
import { fetchLibrary, type ManagedClip } from "@/lib/api";
import {
  createFolderEdit,
  deleteFolderEdit,
  duplicateFolderEdit,
  isFolderEditConflict,
  listFolderEdits,
  renderFolderEdit,
  updateFolderEdit,
} from "@/lib/api.folders";
import type { FolderClip, FolderDetail, FolderEdit } from "@/lib/social-types";

export function FolderEditsSheet({
  visible,
  token,
  folder,
  clip,
  onClose,
  onNotice,
  onError,
  onRefresh,
}: {
  visible: boolean;
  token: string;
  folder: FolderDetail;
  clip: FolderClip;
  onClose: () => void;
  onNotice: (value: string | null) => void;
  onError: (value: string | null) => void;
  onRefresh: () => Promise<void>;
}) {
  const [edits, setEdits] = useState<FolderEdit[]>([]);
  const [cloudClips, setCloudClips] = useState<ManagedClip[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const open = edits.find((item) => item.id === openId) ?? null;

  useEffect(() => {
    if (!visible) return;
    void listFolderEdits(token, folder.id, clip.id).then(setEdits);
    void fetchLibrary(token, { page: 1, limit: 50 }).then((page) => {
      setCloudClips(page.clips.filter((item) => item.status === "ready" && item.id !== clip.id));
    });
  }, [clip.id, folder.id, token, visible]);

  useEffect(() => {
    setNameDraft(open?.name ?? "");
  }, [open?.id, open?.name]);

  async function handleConflict(caught: unknown) {
    if (!isFolderEditConflict(caught)) {
      onError(caught instanceof Error ? caught.message : "Could not save that edit.");
      return;
    }
    Alert.alert("This edit was changed by another collaborator.", undefined, [
      {
        text: "Reload Latest",
        onPress: () => {
          void listFolderEdits(token, folder.id, clip.id).then(setEdits);
        },
      },
      {
        text: "Save as New Edit",
        onPress: () => {
          if (!open) return;
          void duplicateFolderEdit(token, folder.id, clip.id, open.id).then((copy) => {
            setEdits((current) => [copy, ...current]);
            setOpenId(copy.id);
          });
        },
      },
      { text: "Cancel", style: "cancel" },
    ]);
  }

  return (
    <FolderSheetFrame visible={visible} title={`Edits · ${clip.title || "Untitled clip"}`} onClose={onClose}>
      <Text style={folderStyles.muted}>
        These versions belong to the folder. The original clip is not overwritten.
      </Text>
      {edits.map((edit) => (
        <View key={edit.id} style={folderStyles.memberRow}>
          <View style={folderStyles.memberMain}>
            <Text style={folderStyles.memberName}>{edit.name}</Text>
            <Text style={folderStyles.muted}>
              {edit.createdBy.displayName} · {edit.renderedClipId ? "Rendered Copy" : "Draft"} ·{" "}
              {new Date(edit.updatedAt).toLocaleString()}
            </Text>
          </View>
          <Pressable onPress={() => setOpenId(edit.id)}>
            <Text style={{ color: "#7fd0ef" }}>{edit.canModify ? "Open" : "View"}</Text>
          </Pressable>
        </View>
      ))}
      {folder.permissions.createEdits ? (
        <Button
          label="Create Edit"
          kind="primary"
          onPress={() => {
            void createFolderEdit(token, folder.id, clip.id, { name: "Untitled Edit" }).then((edit) => {
              setEdits((current) => [edit, ...current]);
              setOpenId(edit.id);
            });
          }}
        />
      ) : (
        <Text style={folderStyles.muted}>You can view edit metadata, but you cannot change drafts.</Text>
      )}
      {open ? (
        <View style={{ gap: 10 }}>
          <Text style={folderStyles.sectionTitle}>{open.name}</Text>
          {open.canModify ? (
            <>
              <TextInput
                value={nameDraft}
                onChangeText={setNameDraft}
                placeholder="Edit name"
                placeholderTextColor="#8b93a1"
                style={folderStyles.input}
              />
              <Button
                label="Save name"
                onPress={() => {
                  const name = nameDraft.trim();
                  if (!name || name === open.name) return;
                  void updateFolderEdit(token, folder.id, clip.id, open.id, {
                    expectedRevision: open.revision,
                    name,
                  })
                    .then((next) => setEdits((current) => current.map((item) => (item.id === next.id ? next : item))))
                    .catch(handleConflict);
                }}
              />
            </>
          ) : null}
          {folder.permissions.createEdits ? (
            <Button
              label="Duplicate"
              onPress={() =>
                void duplicateFolderEdit(token, folder.id, clip.id, open.id).then((copy) => {
                  setEdits((current) => [copy, ...current]);
                  setOpenId(copy.id);
                })
              }
            />
          ) : null}
          {open.canRender ? (
            <>
              <Text style={folderStyles.muted}>
                Attach a rendered copy you already uploaded. This never replaces the original.
              </Text>
              {cloudClips.map((item) => (
                <Pressable
                  key={item.id}
                  style={folderStyles.memberRow}
                  onPress={() => {
                    void renderFolderEdit(token, folder.id, clip.id, open.id, { clipId: item.id })
                      .then(async (next) => {
                        setEdits((current) => current.map((row) => (row.id === next.id ? next : row)));
                        onNotice("Rendered copy added. The original is unchanged.");
                        await onRefresh();
                      })
                      .catch((caught) =>
                        onError(caught instanceof Error ? caught.message : "Could not attach that copy."),
                      );
                  }}
                >
                  <Text style={folderStyles.memberName}>{item.title || "Untitled clip"}</Text>
                  <Text style={{ color: "#7fd0ef" }}>Use as render</Text>
                </Pressable>
              ))}
            </>
          ) : null}
          {open.canDelete ? (
            <Button
              label="Delete edit"
              kind="danger"
              onPress={() =>
                Alert.alert("Delete this folder edit?", "Rendered copies already in the folder stay.", [
                  { text: "Cancel", style: "cancel" },
                  {
                    text: "Delete",
                    style: "destructive",
                    onPress: () => {
                      void deleteFolderEdit(token, folder.id, clip.id, open.id).then(() => {
                        setEdits((current) => current.filter((item) => item.id !== open.id));
                        setOpenId(null);
                      });
                    },
                  },
                ])
              }
            />
          ) : null}
        </View>
      ) : null}
    </FolderSheetFrame>
  );
}
