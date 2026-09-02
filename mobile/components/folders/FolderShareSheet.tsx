import { useEffect, useState } from "react";
import { Alert, Pressable, Share, Text, TextInput, View } from "react-native";
import { Avatar } from "@/components/Avatar";
import { FolderSheetFrame } from "@/components/folders/FolderSheetFrame";
import { folderStyles } from "@/components/folders/folderStyles";
import { Button, Notice } from "@/components/ui";
import { colors } from "@/lib/theme";
import {
  createFolderInvite,
  deleteFolderInvite,
  disableFolderPublicLink,
  enableFolderPublicLink,
  folderInviteRoles,
  folderRoleLabel,
  listFolderInvites,
  listFolderMembers,
  regenerateFolderPublicLink,
  removeFolderMember,
  transferFolderOwnership,
  updateFolderMemberRole,
  updateFolderPublicDownloads,
} from "@/lib/api.folders";
import { searchUsers } from "@/lib/api.friends";
import type {
  FolderDetail,
  FolderInvite,
  FolderMember,
  FolderMemberRole,
  FolderPublicShare,
  SocialUser,
} from "@/lib/social-types";

function pickRole(title: string, roles: FolderMemberRole[], onPick: (role: FolderMemberRole) => void) {
  Alert.alert(title, undefined, [
    ...roles.map((role) => ({ text: folderRoleLabel(role), onPress: () => onPick(role) })),
    { text: "Cancel", style: "cancel" as const },
  ]);
}

export function FolderShareSheet({
  visible,
  token,
  folder,
  onClose,
  onFolder,
  onError,
}: {
  visible: boolean;
  token: string;
  folder: FolderDetail;
  onClose: () => void;
  onFolder: (folder: FolderDetail) => void;
  onError: (value: string | null) => void;
}) {
  const [owner, setOwner] = useState<SocialUser | null>(null);
  const [members, setMembers] = useState<FolderMember[]>([]);
  const [invites, setInvites] = useState<FolderInvite[]>([]);
  const [inviteRoles, setInviteRoles] = useState<FolderMemberRole[]>([]);
  const [publicShare, setPublicShare] = useState<FolderPublicShare | null>(folder.publicShare ?? null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SocialUser[]>([]);
  const [picked, setPicked] = useState<SocialUser | null>(null);
  const [role, setRole] = useState<FolderMemberRole>("viewer");
  const [notice, setNotice] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const inviteRolesForUi = inviteRoles.length > 0 ? inviteRoles : folderInviteRoles(folder);

  function seedFromFolder() {
    setOwner(folder.owner);
    setMembers(
      (folder.membersPreview ?? []).map((user) => ({
        user,
        role: "viewer" as const,
        createdAt: folder.createdAt,
        invitedBy: null,
        canChangeRole: false,
        allowedRoles: [] as FolderMemberRole[],
        canRemove: false,
      })),
    );
    const roles = folderInviteRoles(folder);
    setInviteRoles(roles);
    if (roles[0]) setRole(roles[0]);
  }

  async function refreshPeople() {
    seedFromFolder();
    try {
      const people = await listFolderMembers(token, folder.id);
      setOwner(people.owner);
      setMembers(people.members);
      setInviteRoles(people.inviteRoles);
      if (people.inviteRoles[0]) setRole(people.inviteRoles[0]);
    } catch {
      /* Folder detail already has owner + preview; keep the sheet usable. */
    }
    if (folder.permissions?.manageMembers) {
      try {
        setInvites(await listFolderInvites(token, folder.id));
      } catch {
        setInvites([]);
      }
    }
  }

  useEffect(() => {
    if (!visible) return;
    setLocalError(null);
    setPublicShare(folder.publicShare ?? null);
    void refreshPeople();
  }, [folder.id, folder.publicShare, visible]);

  useEffect(() => {
    if (query.trim().length < 2) {
      setResults([]);
      return;
    }
    const timer = setTimeout(() => {
      void searchUsers(token, query)
        .then(setResults)
        .catch(() => setResults([]));
    }, 200);
    return () => clearTimeout(timer);
  }, [query, token]);

  function grouped(roleName: FolderMemberRole) {
    return members.filter((member) => member.role === roleName);
  }

  async function sharePublic() {
    if (!publicShare?.url) return;
    await Share.share({ message: `${folder.name}\n${publicShare.url}`, url: publicShare.url });
  }

  return (
    <FolderSheetFrame visible={visible} title="Share" onClose={onClose}>
      {notice ? <Notice tone="ok">{notice}</Notice> : null}
      {localError ? <Notice tone="danger">{localError}</Notice> : null}
      <Text style={folderStyles.sectionTitle}>People with access</Text>
      {(owner ?? folder.owner) ? (
        <View style={folderStyles.memberRow}>
          <Avatar
            name={(owner ?? folder.owner)?.displayName}
            uri={(owner ?? folder.owner)?.avatarUrl}
            size={32}
          />
          <View style={folderStyles.memberMain}>
            <Text style={folderStyles.memberName}>{(owner ?? folder.owner)?.displayName}</Text>
            <Text style={folderStyles.muted}>Owner</Text>
          </View>
        </View>
      ) : null}
      {(["manager", "editor", "viewer"] as const).map((group) => {
        const people = grouped(group);
        if (people.length === 0) return null;
        return (
          <View key={group}>
            <Text style={folderStyles.muted}>{folderRoleLabel(group)}s</Text>
            {people.map((member) => (
              <View key={member.user.id} style={folderStyles.memberRow}>
                <Avatar name={member.user.displayName} uri={member.user.avatarUrl} size={32} />
                <View style={folderStyles.memberMain}>
                  <Text style={folderStyles.memberName}>{member.user.displayName}</Text>
                  <Text style={folderStyles.muted}>{folderRoleLabel(member.role)}</Text>
                </View>
                {member.canChangeRole ? (
                  <Pressable
                    onPress={() =>
                      pickRole("Change role", member.allowedRoles, (next) => {
                        void updateFolderMemberRole(token, folder.id, member.user.id, { role: next }).then((updated) => {
                          setMembers((current) =>
                            current.map((item) => (item.user.id === updated.user.id ? updated : item)),
                          );
                        });
                      })
                    }
                  >
                    <Text style={{ color: colors.accent }}>Role</Text>
                  </Pressable>
                ) : null}
                {member.canRemove ? (
                  <Pressable
                    onPress={() =>
                      Alert.alert(
                        "Remove from folder?",
                        `${member.user.displayName} will lose access. Clips stay where they are.`,
                        [
                          { text: "Cancel", style: "cancel" },
                          {
                            text: "Remove",
                            style: "destructive",
                            onPress: () => {
                              void removeFolderMember(token, folder.id, member.user.id).then(() => {
                                setMembers((current) => current.filter((item) => item.user.id !== member.user.id));
                              });
                            },
                          },
                        ],
                      )
                    }
                  >
                    <Text style={{ color: "#e36b6b" }}>Remove</Text>
                  </Pressable>
                ) : null}
              </View>
            ))}
          </View>
        );
      })}

      {invites.length > 0 ? (
        <>
          <Text style={folderStyles.sectionTitle}>Pending invites</Text>
          {invites.map((invite) => (
            <View key={invite.id} style={folderStyles.memberRow}>
              <View style={folderStyles.memberMain}>
                <Text style={folderStyles.memberName}>{invite.invitee.displayName}</Text>
                <Text style={folderStyles.muted}>{folderRoleLabel(invite.role)} · invited</Text>
              </View>
              {invite.canRevoke ? (
                <Pressable
                  onPress={() =>
                    void deleteFolderInvite(token, folder.id, invite.id).then(() => {
                      setInvites((current) => current.filter((item) => item.id !== invite.id));
                    })
                  }
                >
                  <Text style={{ color: "#e36b6b" }}>Revoke</Text>
                </Pressable>
              ) : null}
            </View>
          ))}
        </>
      ) : null}

      {inviteRolesForUi.length > 0 ? (
        <>
          <Text style={folderStyles.sectionTitle}>Invite people</Text>
          <Text style={folderStyles.muted}>Type a Replayr username or pick a search result, then send.</Text>
          <TextInput
            value={query}
            onChangeText={(value) => {
              setQuery(value);
              setPicked(null);
            }}
            placeholder="Username"
            placeholderTextColor="#8b93a1"
            style={folderStyles.input}
            autoCapitalize="none"
            autoCorrect={false}
          />
          {results.map((user) => (
            <Pressable key={user.id} style={folderStyles.memberRow} onPress={() => setPicked(user)}>
              <Avatar name={user.displayName} uri={user.avatarUrl} size={28} />
              <Text style={folderStyles.memberName}>{user.displayName}</Text>
              {picked?.id === user.id ? <Text style={folderStyles.muted}>Selected</Text> : null}
            </Pressable>
          ))}
          <Button
            label={`Role: ${folderRoleLabel(role)}`}
            onPress={() => pickRole("Invite as", inviteRolesForUi, setRole)}
          />
          <Button
            label="Send invite"
            kind="primary"
            disabled={!picked && query.trim().length < 2}
            onPress={() => {
              const username = query.trim().replace(/^@/, "");
              if (!picked && username.length < 2) return;
              setLocalError(null);
              void createFolderInvite(
                token,
                folder.id,
                picked ? { userId: picked.id, role } : { username, role },
              )
                .then((result) => {
                  if (result.invite) setInvites((current) => [result.invite!, ...current]);
                  setPicked(null);
                  setQuery("");
                  setNotice(result.alreadyMember ? "They already have access." : "Invite sent.");
                })
                .catch((caught) =>
                  setLocalError(caught instanceof Error ? caught.message : "Could not send that invite."),
                );
            }}
          />
        </>
      ) : (
        <Text style={folderStyles.muted}>You can view who has access. Only the owner or a manager can invite people.</Text>
      )}

      <Text style={folderStyles.sectionTitle}>General access</Text>
      {folder.permissions?.managePublicShare ? (
        <>
          <Button
            label={publicShare?.enabled ? "Public link on" : "Enable public link"}
            kind={publicShare?.enabled ? "default" : "primary"}
            onPress={() => {
              void (publicShare?.enabled
                ? disableFolderPublicLink(token, folder.id)
                : enableFolderPublicLink(token, folder.id)
              ).then(setPublicShare);
            }}
          />
          {publicShare?.enabled ? (
            <>
              <Text style={folderStyles.muted}>{publicShare.url}</Text>
              <Button label="Copy / Share link" kind="primary" onPress={() => void sharePublic()} />
              <Button
                label={publicShare.allowDownloads ? "Downloads on" : "Allow downloads"}
                onPress={() =>
                  void updateFolderPublicDownloads(token, folder.id, !publicShare.allowDownloads).then(setPublicShare)
                }
              />
              <Button
                label="Regenerate link"
                onPress={() =>
                  Alert.alert("Regenerate public link?", "The old link will stop working.", [
                    { text: "Cancel", style: "cancel" },
                    {
                      text: "Regenerate",
                      style: "destructive",
                      onPress: () => {
                        void regenerateFolderPublicLink(token, folder.id).then(setPublicShare);
                      },
                    },
                  ])
                }
              />
              <Button label="Disable link" kind="danger" onPress={() => void disableFolderPublicLink(token, folder.id).then(setPublicShare)} />
            </>
          ) : (
            <Text style={folderStyles.muted}>Private. Only people with access can view this folder.</Text>
          )}
        </>
      ) : (
        <Text style={folderStyles.muted}>
          {publicShare?.enabled ? "Anyone with the link can view this folder." : "Only people with access can view this folder."}
        </Text>
      )}

      {folder.permissions?.transferOwnership ? (
        <>
          <Text style={folderStyles.sectionTitle}>Ownership</Text>
          <Text style={folderStyles.muted}>Current owner: {owner?.displayName ?? "You"}</Text>
          {members.map((member) => (
            <Button
              key={member.user.id}
              label={`Transfer to ${member.user.displayName}`}
              onPress={() =>
                Alert.alert(
                  "Transfer ownership?",
                  `${member.user.displayName} will become Owner. You will become Manager.`,
                  [
                    { text: "Cancel", style: "cancel" },
                    {
                      text: "Transfer",
                      style: "destructive",
                      onPress: () => {
                        void transferFolderOwnership(token, folder.id, { userId: member.user.id })
                          .then((next) => {
                            onFolder(next);
                            setNotice("Ownership transferred. You are now a Manager.");
                            void refreshPeople();
                          })
                          .catch((caught) =>
                            onError(caught instanceof Error ? caught.message : "Could not transfer ownership."),
                          );
                      },
                    },
                  ],
                )
              }
            />
          ))}
        </>
      ) : null}
    </FolderSheetFrame>
  );
}
