import { useEffect, useState } from "react";
import { Text, TextInput } from "react-native";
import { FolderSheetFrame } from "@/components/folders/FolderSheetFrame";
import { staffStyles } from "@/components/staff/staffStyles";
import { Button, Notice } from "@/components/ui";
import { deleteStaffBoard } from "@/lib/api.staff";
import { colors } from "@/lib/theme";

export function StaffDeleteBoardSheet({
  visible,
  token,
  boardId,
  boardName,
  onClose,
  onDeleted,
}: {
  visible: boolean;
  token: string;
  boardId: string;
  boardName: string;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const confirmed = confirmation === boardName;

  useEffect(() => {
    if (!visible) return;
    setConfirmation("");
    setError(null);
    setBusy(false);
  }, [visible]);

  async function remove() {
    if (!confirmed) {
      setError("Enter the exact board name to continue.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await deleteStaffBoard(token, boardId, confirmation);
      onClose();
      onDeleted();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not delete that board.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <FolderSheetFrame
      visible={visible}
      title="Permanently delete board"
      onClose={onClose}
      footer={
        <Button
          label={busy ? "Deleting…" : "Permanently delete"}
          kind="danger"
          disabled={busy || !confirmed}
          onPress={() => void remove()}
        />
      }
    >
      <Notice tone="danger">This permanently deletes “{boardName}” and its contents. This cannot be undone.</Notice>
      <Text style={staffStyles.muted}>Enter the exact board name to confirm:</Text>
      <Text style={staffStyles.confirmName}>{boardName}</Text>
      <TextInput
        style={staffStyles.input}
        placeholder="Exact board name"
        placeholderTextColor={colors.muted}
        value={confirmation}
        onChangeText={setConfirmation}
        autoCapitalize="none"
        autoCorrect={false}
      />
      {error ? <Notice tone="danger">{error}</Notice> : null}
    </FolderSheetFrame>
  );
}
