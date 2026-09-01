/**
 * Shared social API types. Source of truth for desktop, worker, and clients.
 */

export type FriendshipStatus = "pending" | "accepted" | "blocked";
export type FollowStatus = "pending" | "accepted";
export type Relationship = "none" | "outgoing" | "incoming" | "friends" | "following" | "follower" | "blocked";
export type ConversationType = "dm" | "group";
export type ConversationRole = "owner" | "member";
export type NotificationKind =
  | "friend_request"
  | "friend_accept"
  | "follow_request"
  | "follow_accept"
  | "message"
  | "group_invite"
  | "folder_invite"
  | "folder_invite_accepted"
  | "folder_role_changed"
  | "folder_ownership_transferred";

export type FollowState = {
  viewerFollows: boolean;
  viewerFollowPending: boolean;
  followsViewer: boolean;
  incomingPending: boolean;
  mutual: boolean;
  blocked: boolean;
};

export type SocialUser = {
  id: string;
  username: string | null;
  displayName: string;
  avatarUrl: string | null;
  verified: boolean;
};

export type Friend = SocialUser & {
  friendshipId: string;
  since: string;
  dmId: string | null;
};

export type FriendRequest = {
  id: string;
  createdAt: string;
  from: SocialUser;
  to: SocialUser;
};

export type FriendRequestsResponse = {
  incoming: FriendRequest[];
  outgoing: FriendRequest[];
};

export type FriendsResponse = {
  friends: Friend[];
};

export type CreateFriendRequestBody = {
  username?: string;
  userId?: string;
};

export type UsersSearchResponse = {
  users: Array<SocialUser & { relationship: Relationship }>;
};

export type UserSuggestionsResponse = {
  users: Array<SocialUser & { relationship: Relationship }>;
};

export type PublicClipCard = {
  id: string;
  title: string | null;
  description?: string | null;
  slug: string;
  durationMs: number | null;
  createdAt: string;
  viewCount: number;
  thumbnailUrl: string | null;
  playbackUrl: string | null;
  game: { name: string; slug: string; coverUrl: string | null } | null;
  author: {
    username: string | null;
    displayName: string | null;
    avatarUrl: string | null;
    verified?: boolean;
    isPrivate?: boolean;
  };
  likeCount: number;
  commentCount: number;
  liked: boolean;
  following?: boolean;
  followPending?: boolean;
  watermark?: boolean;
};

export type FriendClipsResponse = {
  clips: PublicClipCard[];
};

export type ProfilePost = {
  id: string;
  body: string;
  createdAt: string;
  clip: PublicClipCard | null;
  author: SocialUser;
};

export type CreatePostBody = {
  body: string;
  clipId?: string;
};

export type UserProfileResponse = {
  user: SocialUser & {
    bio: string | null;
    clipCount: number;
    createdAt: string;
  };
  follow: FollowState;
  relationship: Relationship;
  isPrivate: boolean;
  locked: boolean;
  clips: PublicClipCard[];
  posts: ProfilePost[];
};

export type FollowListItem = SocialUser & {
  since: string;
};

export type FollowListResponse = {
  users: FollowListItem[];
};

export type FollowRequestsResponse = {
  incoming: FriendRequest[];
  outgoing: FriendRequest[];
};

export type FollowActionResponse = {
  follow: FollowState;
  status: FollowStatus | null;
};

export type ProfilePostsResponse = {
  posts: ProfilePost[];
  page: number;
  limit: number;
};

export type MessageClip = {
  id: string;
  slug: string;
  title: string | null;
  durationMs: number | null;
  thumbnailUrl: string | null;
  visibility: "public" | "unlisted" | "private";
  game: { name: string; slug: string } | null;
};

export type ChatMessage = {
  id: string;
  conversationId: string;
  senderId: string;
  body: string | null;
  createdAt: string;
  sender: SocialUser;
  clip: MessageClip | null;
};

export type ConversationSummary = {
  id: string;
  type: ConversationType;
  title: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  members: Array<SocialUser & { role: ConversationRole }>;
  lastMessage: ChatMessage | null;
  unreadCount: number;
};

export type ConversationsResponse = {
  conversations: ConversationSummary[];
};

export type ConversationResponse = {
  conversation: ConversationSummary;
};

export type CreateConversationBody = {
  type: ConversationType;
  userId?: string;
  title?: string | null;
  memberIds?: string[];
};

export type AddMembersBody = {
  userId?: string;
  userIds?: string[];
};

export type MessagesResponse = {
  messages: ChatMessage[];
};

export type PostMessageBody = {
  body?: string;
  clipId?: string;
};

export type SendClipBody = {
  conversationId: string;
};

export type SendClipResponse = {
  message: ChatMessage;
  conversationId: string;
};

export type NotificationItem = {
  id: string;
  kind: NotificationKind;
  createdAt: string;
  readAt: string | null;
  actor: SocialUser | null;
  friendshipId: string | null;
  conversationId: string | null;
  messageId: string | null;
  folderId: string | null;
};

export type NotificationsResponse = {
  notifications: NotificationItem[];
};

export type ReadNotificationsBody = {
  ids?: string[];
};

export type ReadNotificationsResponse = {
  read: true;
};

export type FolderRole = "owner" | "manager" | "editor" | "viewer" | "public";
export type FolderMemberRole = "manager" | "editor" | "viewer";
export type FolderVisibility = "private" | "public_link";
export type FolderInviteStatus = "pending" | "accepted" | "declined";

export type FolderPermissions = {
  view: boolean;
  download: boolean;
  addClips: boolean;
  removeClips: boolean;
  editClips: boolean;
  manageFolder: boolean;
  manageMembers: boolean;
  managePublicShare: boolean;
  deleteFolder: boolean;
  transferOwnership: boolean;
  viewEdits: boolean;
  createEdits: boolean;
  modifyEdits: boolean;
  deleteOwnEdits: boolean;
  deleteAnyEdits: boolean;
  renderEdits: boolean;
};

export type FolderPublicShare = {
  enabled: boolean;
  url: string | null;
  allowDownloads: boolean;
};

export type Folder = {
  id: string;
  name: string;
  description: string | null;
  visibility: FolderVisibility;
  allowDownloads: boolean;
  clipCount: number;
  coverThumbnailUrl: string | null;
  createdAt: string;
  updatedAt: string;
  role: FolderRole;
  permissions: FolderPermissions;
  owner: SocialUser | null;
  membersPreview: SocialUser[];
  publicShare?: FolderPublicShare | null;
};

export type FolderClipKind = "original" | "render";

export type FolderClip = {
  id: string;
  title: string | null;
  slug: string;
  status: "uploading" | "processing" | "ready" | "failed" | "deleted";
  visibility: "public" | "unlisted" | "private";
  durationMs: number | null;
  createdAt: string;
  addedAt: string;
  thumbnailUrl: string | null;
  ownerId: string;
  kind: FolderClipKind;
};

export type FolderMember = {
  user: SocialUser;
  role: FolderMemberRole;
  createdAt: string;
  invitedBy: SocialUser | null;
  canChangeRole: boolean;
  allowedRoles: FolderMemberRole[];
  canRemove: boolean;
};

export type FolderInvite = {
  id: string;
  folderId: string;
  folderName?: string;
  role: FolderMemberRole;
  status: FolderInviteStatus;
  createdAt: string;
  invitee: SocialUser;
  inviter: SocialUser;
  canRevoke?: boolean;
};

export type FolderDetail = Folder & {
  clips: FolderClip[];
};

export type FoldersResponse = {
  folders: Folder[];
};

export type FolderResponse = {
  folder: FolderDetail;
};

export type CreateFolderBody = {
  name: string;
  description?: string;
};

export type UpdateFolderBody = {
  name?: string;
  description?: string | null;
};

export type AddFolderClipsBody = {
  clipIds: string[];
};

export type FolderMembersResponse = {
  owner: SocialUser;
  members: FolderMember[];
  inviteRoles: FolderMemberRole[];
  permissions: FolderPermissions;
};

export type FolderInvitesResponse = {
  invites: FolderInvite[];
};

export type IncomingFolderInvitesResponse = {
  invites: FolderInvite[];
};

export type CreateFolderInviteBody = {
  username?: string;
  userId?: string;
  role: FolderMemberRole;
};

export type FolderInviteResponse = {
  invite: FolderInvite | null;
  alreadyMember: boolean;
  role?: FolderRole;
};

export type UpdateFolderMemberBody = {
  role: FolderMemberRole;
};

export type TransferFolderOwnershipBody = {
  userId?: string;
  username?: string;
};

export type FolderEditDocument = {
  version: 1;
  trim?: { startMs: number; endMs: number };
  composition?: {
    cropX?: number;
    webcam?: {
      placement?: string;
      shape?: string;
      width?: number;
      x?: number | null;
      y?: number | null;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  visuals?: {
    filter?: string;
    overlays?: { recIndicator?: boolean; timestamp?: boolean };
    [key: string]: unknown;
  };
  webcam?: {
    placement?: string;
    shape?: string;
    width?: number;
    x?: number | null;
    y?: number | null;
    [key: string]: unknown;
  };
  overlays?: Array<Record<string, unknown>>;
  audio?: Record<string, unknown>;
  [key: string]: unknown;
};

export type FolderEditContext =
  | { kind: "personal" }
  | {
      kind: "folderEdit";
      folderId: string;
      sourceClipId: string;
      editId: string;
    };

export type FolderEdit = {
  id: string;
  folderId: string;
  clipId: string;
  name: string;
  revision: number;
  editData: FolderEditDocument;
  renderedClipId: string | null;
  createdBy: SocialUser;
  updatedBy: SocialUser;
  createdAt: string;
  updatedAt: string;
  canModify: boolean;
  canDelete: boolean;
  canRender: boolean;
};

export type FolderEditsResponse = {
  edits: FolderEdit[];
};

export type FolderEditResponse = {
  edit: FolderEdit;
};

export type CreateFolderEditBody = {
  name?: string;
  editData?: FolderEditDocument;
};

export type UpdateFolderEditBody = {
  expectedRevision: number;
  name?: string;
  editData?: FolderEditDocument;
};

export type RenderFolderEditBody = {
  clipId: string;
};

export type FolderActivityKind =
  | "edit_created"
  | "edit_rendered"
  | "edit_deleted"
  | "clip_added"
  | "clip_removed"
  | "member_role_changed"
  | "ownership_transferred";

export type FolderActivity = {
  id: string;
  folderId: string;
  kind: FolderActivityKind;
  entityId: string | null;
  actor: SocialUser;
  createdAt: string;
  summary: string;
};

export type FolderActivityResponse = {
  activities: FolderActivity[];
};

export function folderRoleLabel(role: FolderRole | FolderMemberRole): string {
  if (role === "owner") return "Owner";
  if (role === "manager") return "Manager";
  if (role === "editor") return "Editor";
  if (role === "viewer") return "Viewer";
  return "Public";
}

export function folderInviteRoles(folder: {
  role?: FolderRole | string;
  permissions?: Pick<FolderPermissions, "manageMembers"> | null;
}): FolderMemberRole[] {
  if (!folder.permissions?.manageMembers) return [];
  if (folder.role === "owner") return ["manager", "editor", "viewer"];
  if (folder.role === "manager") return ["editor", "viewer"];
  return [];
}

export function folderAccessLabel(folder: {
  visibility?: string;
  publicShare?: { enabled?: boolean } | null;
  membersPreview?: unknown[];
}): "Public" | "Shared" | "Private" {
  if (folder.visibility === "public_link" || folder.publicShare?.enabled) return "Public";
  if ((folder.membersPreview?.length ?? 0) > 0) return "Shared";
  return "Private";
}

export function mergeFolderEditDocument(
  current: FolderEditDocument,
  patch: Partial<FolderEditDocument>,
): FolderEditDocument {
  return {
    ...current,
    ...patch,
    version: 1,
    composition:
      patch.composition || current.composition
        ? ({ ...current.composition, ...patch.composition } as FolderEditDocument["composition"])
        : undefined,
    visuals:
      patch.visuals || current.visuals
        ? ({ ...current.visuals, ...patch.visuals } as FolderEditDocument["visuals"])
        : undefined,
    webcam:
      patch.webcam || current.webcam
        ? ({ ...current.webcam, ...patch.webcam } as FolderEditDocument["webcam"])
        : undefined,
    audio: patch.audio || current.audio ? { ...current.audio, ...patch.audio } : undefined,
  };
}

export function isFolderEditConflict(error: unknown): boolean {
  return error instanceof Error && /changed by another collaborator|updated elsewhere/i.test(error.message);
}

function fallbackPermissions(role: Folder["role"]): FolderPermissions {
  const manageEdits = {
    viewEdits: true,
    createEdits: true,
    modifyEdits: true,
    deleteOwnEdits: true,
    deleteAnyEdits: role === "owner" || role === "manager",
    renderEdits: true,
  };
  if (role === "owner") {
    return {
      view: true,
      download: true,
      addClips: true,
      removeClips: true,
      editClips: true,
      manageFolder: true,
      manageMembers: true,
      managePublicShare: true,
      deleteFolder: true,
      transferOwnership: true,
      ...manageEdits,
    };
  }
  if (role === "manager") {
    return { ...fallbackPermissions("owner"), deleteFolder: false, transferOwnership: false };
  }
  if (role === "editor") {
    return {
      view: true,
      download: true,
      addClips: true,
      removeClips: true,
      editClips: true,
      manageFolder: false,
      manageMembers: false,
      managePublicShare: false,
      deleteFolder: false,
      transferOwnership: false,
      ...manageEdits,
      deleteAnyEdits: false,
    };
  }
  return {
    view: true,
    download: true,
    addClips: false,
    removeClips: false,
    editClips: false,
    manageFolder: false,
    manageMembers: false,
    managePublicShare: false,
    deleteFolder: false,
    transferOwnership: false,
    viewEdits: true,
    createEdits: false,
    modifyEdits: false,
    deleteOwnEdits: false,
    deleteAnyEdits: false,
    renderEdits: false,
  };
}

export function normalizeFolder<T extends Folder>(folder: T): T {
  return {
    ...folder,
    membersPreview: folder.membersPreview ?? [],
    permissions: folder.permissions ?? fallbackPermissions(folder.role),
  };
}

export function normalizeFolderDetail(folder: FolderDetail): FolderDetail {
  return {
    ...normalizeFolder(folder),
    clips: folder.clips ?? [],
  };
}

export type FolderPlaybackResponse = {
  playbackUrl: string;
};

export type FolderPublicLinkResponse = {
  publicShare: FolderPublicShare;
};

export type UpdateFolderPublicLinkBody = {
  allowDownloads: boolean;
};

export type PublicFolderOwner = {
  username: string | null;
  displayName: string;
  avatarUrl: string | null;
};

export type PublicFolderClip = {
  id: string;
  title: string | null;
  durationMs: number | null;
  createdAt: string;
  thumbnailUrl: string | null;
};

export type PublicFolder = {
  id: string;
  name: string;
  description: string | null;
  owner: PublicFolderOwner | null;
  clipCount: number;
  allowDownloads: boolean;
  coverThumbnailUrl: string | null;
  clips: PublicFolderClip[];
};

export type PublicFolderResponse = {
  folder: PublicFolder;
};

export type PublicFolderPlaybackResponse = {
  playbackUrl: string;
};

export type PublicFolderDownloadResponse = {
  downloadUrl: string;
};
