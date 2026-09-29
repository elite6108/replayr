import { Alert, Pressable, Text, View } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import * as Linking from "expo-linking";
import { staffStyles } from "@/components/staff/staffStyles";
import { formatBytes } from "@/lib/format";
import type { StaffTaskDetail } from "@/lib/api.staff";
import { colors } from "@/lib/theme";

export function StaffTaskAttachments({
  attachments,
  uploadLabel,
  canUpload,
  canDelete,
  onOpen,
  onUpload,
  onDelete,
}: {
  attachments: StaffTaskDetail["attachments"];
  uploadLabel: string | null;
  canUpload: boolean;
  canDelete: boolean;
  onOpen: (id: string) => void;
  onUpload: (file: { uri: string; name: string; mime: string; bytes: number }) => void;
  onDelete: (id: string) => void;
}) {
  async function browse() {
    const result = await DocumentPicker.getDocumentAsync({
      type: ["image/jpeg", "image/png", "image/webp", "application/pdf", "text/plain"],
      copyToCacheDirectory: true,
    });
    if (result.canceled || !result.assets[0]) return;
    const file = result.assets[0];
    onUpload({
      uri: file.uri,
      name: file.name || "file",
      mime: file.mimeType || "application/octet-stream",
      bytes: file.size ?? 0,
    });
  }

  return (
    <View style={staffStyles.sectionCard}>
      <View style={staffStyles.sectionHead}>
        <Text style={staffStyles.cardTitle}>Attachments</Text>
        <Text style={staffStyles.kanbanCount}>{attachments.length}</Text>
      </View>
      {canUpload ? (
        <Pressable style={staffStyles.hubRow} onPress={() => void browse()}>
          <View>
            <Text style={staffStyles.hubLabel}>Tap to browse</Text>
            <Text style={staffStyles.hubHint}>Images, PDFs, and text (max 25 MB)</Text>
          </View>
        </Pressable>
      ) : null}
      {uploadLabel ? <Text style={staffStyles.saveHint}>{uploadLabel}</Text> : null}
      {attachments.map((file) => (
        <View key={file.id} style={staffStyles.hubRow}>
          <Pressable style={{ flex: 1 }} onPress={() => onOpen(file.id)}>
            <Text style={staffStyles.hubLabel}>{file.filename}</Text>
            <Text style={staffStyles.hubHint}>{file.bytes ? formatBytes(file.bytes) : file.mime ?? "File"}</Text>
          </Pressable>
          {canDelete ? (
            <Pressable
              onPress={() =>
                Alert.alert("Remove attachment?", undefined, [
                  { text: "Cancel", style: "cancel" },
                  { text: "Remove", style: "destructive", onPress: () => onDelete(file.id) },
                ])
              }
            >
              <Text style={{ color: colors.danger, fontWeight: "700" }}>Remove</Text>
            </Pressable>
          ) : null}
        </View>
      ))}
      {attachments.length === 0 ? <Text style={staffStyles.muted}>No attachments.</Text> : null}
    </View>
  );
}
