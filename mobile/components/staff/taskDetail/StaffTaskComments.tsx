import { useState } from "react";
import { Alert, Pressable, Text, TextInput, View } from "react-native";
import { staffStyles } from "@/components/staff/staffStyles";
import { Button } from "@/components/ui";
import { formatTimeAgo } from "@/lib/format";
import type { StaffTaskDetail } from "@/lib/api.staff";
import { colors } from "@/lib/theme";

const EMOJI = ["👍", "❤️", "🎉", "🔥", "👀", "😂", "✅", "🙏", "💡", "🚀"];

export function StaffTaskComments({
  comments,
  draft,
  staffId,
  canComment,
  canModerate,
  onDraft,
  onPost,
  onEdit,
  onDelete,
}: {
  comments: StaffTaskDetail["comments"];
  draft: string;
  staffId: string | null;
  canComment: boolean;
  canModerate: boolean;
  onDraft: (value: string) => void;
  onPost: () => void;
  onEdit: (id: string, body: string) => void;
  onDelete: (id: string) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBody, setEditBody] = useState("");

  return (
    <View style={staffStyles.sectionCard}>
      <View style={staffStyles.sectionHead}>
        <Text style={staffStyles.cardTitle}>Comments</Text>
        <Text style={staffStyles.kanbanCount}>{comments.length}</Text>
      </View>
      {comments.map((item) => {
        const own = Boolean(staffId && item.authorStaffId === staffId);
        const editing = editingId === item.id;
        return (
          <View key={item.id} style={staffStyles.comment}>
            <Text style={staffStyles.commentName}>
              {item.authorName} <Text style={staffStyles.muted}>{formatTimeAgo(item.createdAt)}</Text>
            </Text>
            {editing ? (
              <>
                <TextInput
                  style={staffStyles.input}
                  value={editBody}
                  onChangeText={setEditBody}
                  multiline
                />
                <View style={staffStyles.row}>
                  <Button
                    label="Save"
                    kind="primary"
                    onPress={() => {
                      onEdit(item.id, editBody.trim());
                      setEditingId(null);
                    }}
                  />
                  <Button label="Cancel" onPress={() => setEditingId(null)} />
                </View>
              </>
            ) : (
              <Text style={staffStyles.commentBody}>{item.body}</Text>
            )}
            {(own || canModerate) && !editing ? (
              <View style={staffStyles.row}>
                {own ? (
                  <Pressable
                    onPress={() => {
                      setEditingId(item.id);
                      setEditBody(item.body);
                    }}
                  >
                    <Text style={staffStyles.muted}>Edit</Text>
                  </Pressable>
                ) : null}
                <Pressable
                  onPress={() =>
                    Alert.alert("Delete comment?", undefined, [
                      { text: "Cancel", style: "cancel" },
                      { text: "Delete", style: "destructive", onPress: () => onDelete(item.id) },
                    ])
                  }
                >
                  <Text style={{ color: colors.danger, fontWeight: "700" }}>Delete</Text>
                </Pressable>
              </View>
            ) : null}
          </View>
        );
      })}
      {comments.length === 0 ? <Text style={staffStyles.muted}>No comments yet.</Text> : null}
      {canComment ? (
        <>
          <View style={staffStyles.row}>
            {EMOJI.map((item) => (
              <Pressable key={item} onPress={() => onDraft(`${draft}${item}`)}>
                <Text style={{ fontSize: 18 }}>{item}</Text>
              </Pressable>
            ))}
          </View>
          <TextInput
            style={staffStyles.input}
            value={draft}
            onChangeText={onDraft}
            placeholder="Comment. Use @username to mention."
            placeholderTextColor={colors.muted}
          />
          <Button label="Post" kind="primary" disabled={!draft.trim()} onPress={onPost} />
        </>
      ) : null}
    </View>
  );
}
