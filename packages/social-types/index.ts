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
  | "folder_invite_accepted";

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
      placement: string;
      shape: string;
      width: number;
      x?: number | null;
      y?: number | null;
    };
  };
  visuals?: {
    filter?: string;
    overlays?: { recIndicator?: boolean; timestamp?: boolean };
  };
  webcam?: {
    placement: string;
    shape: string;
    width: number;
    x?: number | null;
    y?: number | null;
  };
  overlays?: Array<Record<string, unknown>>;
  audio?: Record<string, unknown>;
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
