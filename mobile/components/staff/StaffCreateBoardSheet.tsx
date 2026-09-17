import { useEffect, useState } from "react";
import { Text, TextInput } from "react-native";
import { FolderSheetFrame } from "@/components/folders/FolderSheetFrame";
import { staffStyles } from "@/components/staff/staffStyles";
import { Button, Notice } from "@/components/ui";
import { createStaffBoard } from "@/lib/api.staff";
import { colors } from "@/lib/theme";

export function StaffCreateBoardSheet({
  visible,
  token,
  onClose,
  onCreated,
}: {
  visible: boolean;
  token: string;
  onClose: () => void;
  onCreated: (boardId: string) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setName("");
    setDescription("");
    setError(null);
    setBusy(false);
  }, [visible]);

  async function submit() {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("Board name is required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await createStaffBoard(token, {
        name: trimmedName,
        description: description.trim() || undefined,
      });
      onClose();
      onCreated(result.board.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create that board.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <FolderSheetFrame
      visible={visible}
      title="Create private board"
      onClose={onClose}
      footer={
        <Button
          label={busy ? "Creating…" : "Create board"}
          kind="primary"
          disabled={busy || !name.trim()}
          onPress={() => void submit()}
        />
      }
    >
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <Text style={staffStyles.muted}>Only explicitly added staff can open a private board.</Text>
      <Text style={staffStyles.section}>Name</Text>
      <TextInput
        style={staffStyles.input}
        placeholder="Board name"
        placeholderTextColor={colors.muted}
        value={name}
        onChangeText={setName}
        autoFocus
        maxLength={80}
      />
      <Text style={staffStyles.section}>Description</Text>
      <TextInput
        style={[staffStyles.input, staffStyles.textarea]}
        placeholder="Optional description"
        placeholderTextColor={colors.muted}
        value={description}
        onChangeText={setDescription}
        multiline
        maxLength={280}
      />
    </FolderSheetFrame>
  );
}
