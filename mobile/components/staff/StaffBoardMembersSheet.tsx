import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, Switch, Text, TextInput, View } from "react-native";
import { FolderSheetFrame } from "@/components/folders/FolderSheetFrame";
import { staffStyles } from "@/components/staff/staffStyles";
import { Button, Notice } from "@/components/ui";
import {
  fetchStaffBoardMembers,
  removeStaffBoardMember,
  setStaffBoardEmailNotifications,
  setStaffBoardMemberRole,
  type StaffBoardMember,
  type StaffBoardMembers,
} from "@/lib/api.staff";
import { colors } from "@/lib/theme";

const BOARD_ROLES: StaffBoardMember["boardRole"][] = ["admin", "editor", "viewer"];

export function StaffBoardMembersSheet({
  visible,
  token,
  boardId,
  canManageMembers,
  emailEnabled,
  onClose,
  onChanged,
  onEmailChanged,
}: {
  visible: boolean;
  token: string;
  boardId: string;
  canManageMembers: boolean;
  emailEnabled: boolean;
  onClose: () => void;
  onChanged: () => void;
  onEmailChanged: (enabled: boolean) => void;
}) {
  const [data, setData] = useState<StaffBoardMembers | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [workingId, setWorkingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (showLoading = true) => {
      if (!token || !boardId || !canManageMembers) return;
      if (showLoading) setLoading(true);
      setError(null);
      try {
        setData(await fetchStaffBoardMembers(token, boardId));
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Could not load board members.");
      } finally {
        if (showLoading) setLoading(false);
      }
    },
    [boardId, canManageMembers, token],
  );

  useEffect(() => {
    if (!visible) return;
    setQuery("");
    setData(null);
    setWorkingId(null);
    void load();
  }, [visible, load]);

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const members = useMemo(
    () =>
      (data?.members ?? []).filter(
        (member) => !normalizedQuery || member.displayName.toLocaleLowerCase().includes(normalizedQuery),
      ),
    [data?.members, normalizedQuery],
  );
  const candidates = useMemo(
    () =>
      (data?.candidates ?? []).filter(
        (candidate) => !normalizedQuery || candidate.displayName.toLocaleLowerCase().includes(normalizedQuery),
      ),
    [data?.candidates, normalizedQuery],
  );

  async function saveRole(staffId: string, boardRole: StaffBoardMember["boardRole"]) {
    setWorkingId(staffId);
    setError(null);
    try {
      await setStaffBoardMemberRole(token, boardId, staffId, boardRole);
      await load(false);
      onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update that member.");
    } finally {
      setWorkingId(null);
    }
  }

  function confirmRemove(member: StaffBoardMember) {
    Alert.alert(
      "Remove board member?",
      `${member.displayName} will immediately lose access to this private board.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () => {
            setWorkingId(member.staffId);
            setError(null);
            void removeStaffBoardMember(token, boardId, member.staffId)
              .then(() => load(false))
              .then(onChanged)
              .catch((caught: unknown) => {
                setError(caught instanceof Error ? caught.message : "Could not remove that member.");
              })
              .finally(() => setWorkingId(null));
          },
        },
      ],
    );
  }

  return (
    <FolderSheetFrame visible={visible} title={canManageMembers ? "Board members" : "Board emails"} onClose={onClose}>
      {canManageMembers ? (
      <TextInput
        style={staffStyles.input}
        placeholder="Search staff"
        placeholderTextColor={colors.muted}
        value={query}
        onChangeText={setQuery}
        autoCapitalize="none"
        autoCorrect={false}
      />
      ) : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <View style={staffStyles.card}>
        <View style={staffStyles.memberHeading}>
          <View style={{ flex: 1 }}>
            <Text style={staffStyles.cardTitle}>Email me when this board changes</Text>
            <Text style={staffStyles.muted}>
              Mute this board even if all-boards email is on. Your own edits never email you.
            </Text>
          </View>
          <Switch
            value={emailEnabled}
            onValueChange={(next) => {
              setError(null);
              void setStaffBoardEmailNotifications(token, boardId, next)
                .then((body) => {
                  onEmailChanged(body.emailEnabled);
                  onChanged();
                })
                .catch((caught: unknown) => {
                  setError(caught instanceof Error ? caught.message : "Could not update board emails.");
                });
            }}
            trackColor={{ false: colors.border, true: colors.accent }}
            thumbColor={colors.text}
          />
        </View>
      </View>
      {loading ? (
        <View style={staffStyles.loadingRow}>
          <ActivityIndicator color={colors.accent} />
          <Text style={staffStyles.muted}>Loading members…</Text>
        </View>
      ) : null}
      {!loading && !data && error ? <Button label="Try again" onPress={() => void load()} /> : null}
      {data && canManageMembers ? (
        <>
          <Text style={staffStyles.section}>Members</Text>
          {members.map((member) => {
            const busy = workingId === member.staffId;
            return (
              <View key={member.staffId} style={staffStyles.memberRow}>
                <View style={staffStyles.memberHeading}>
                  <View style={{ flex: 1 }}>
                    <Text style={staffStyles.cardTitle}>{member.displayName}</Text>
                    <Text style={staffStyles.muted}>{member.isOwner ? "Board owner" : `${member.boardRole} access`}</Text>
                  </View>
                  {busy ? <ActivityIndicator color={colors.accent} /> : null}
                </View>
                {member.isOwner ? (
                  <Text style={staffStyles.ownerLock}>Owner membership and role are locked.</Text>
                ) : (
                  <>
                    <View style={staffStyles.row}>
                      {BOARD_ROLES.map((role) => (
                        <Pressable
                          key={role}
                          style={[staffStyles.pill, member.boardRole === role && staffStyles.pillOn]}
                          disabled={busy}
                          onPress={() => void saveRole(member.staffId, role)}
                        >
                          <Text style={[staffStyles.pillText, member.boardRole === role && staffStyles.pillTextOn]}>
                            {role}
                          </Text>
                        </Pressable>
                      ))}
                    </View>
                    <Pressable
                      style={staffStyles.dangerAction}
                      disabled={busy}
                      onPress={() => confirmRemove(member)}
                    >
                      <Text style={staffStyles.dangerActionText}>Remove from board</Text>
                    </Pressable>
                  </>
                )}
              </View>
            );
          })}
          {members.length === 0 ? <Text style={staffStyles.muted}>No matching members.</Text> : null}

          <Text style={staffStyles.section}>Add staff</Text>
          {candidates.map((candidate) => {
            const busy = workingId === candidate.id;
            return (
              <View key={candidate.id} style={staffStyles.candidateRow}>
                <Text style={[staffStyles.cardTitle, { flex: 1 }]}>{candidate.displayName}</Text>
                <Pressable
                  style={[staffStyles.compactAction, busy && staffStyles.disabled]}
                  disabled={busy}
                  onPress={() => void saveRole(candidate.id, "viewer")}
                  accessibilityLabel={`Add ${candidate.displayName} as viewer`}
                >
                  {busy ? (
                    <ActivityIndicator size="small" color={colors.onAccent} />
                  ) : (
                    <Text style={staffStyles.compactActionText}>Add</Text>
                  )}
                </Pressable>
              </View>
            );
          })}
          {candidates.length === 0 ? <Text style={staffStyles.muted}>No matching staff available to add.</Text> : null}
          {candidates.length > 0 ? <Text style={staffStyles.muted}>New members are added as viewers. Change their role above after adding.</Text> : null}
        </>
      ) : null}
    </FolderSheetFrame>
  );
}
