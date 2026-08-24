/**
 * Frozen Worker JSON contract for friends, DMs, groups, and notifications.
 * Copy into desktop `src/services/`, web `src/lib/`, and mobile `lib/` in Wave 2.
 * All routes are under `/v1` and use the same Bearer JWT as clips/likes/comments.
 */

export type FriendshipStatus = "pending" | "accepted" | "blocked";
export type ConversationType = "dm" | "group";
export type ConversationRole = "owner" | "member";
export type NotificationKind =
  | "friend_request"
  | "friend_accept"
  | "message"
  | "group_invite"
  | "clip_like"
  | "clip_comment";
export type Relationship = "none" | "outgoing" | "incoming" | "friends" | "blocked";

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

export type FriendClipsResponse = {
  clips: PublicClipCard[];
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
  };
  likeCount: number;
  commentCount: number;
  liked: boolean;
};

export type UserProfileResponse = {
  user: SocialUser & {
    bio: string | null;
    clipCount: number;
    createdAt: string;
  };
  relationship: Relationship;
  clips: PublicClipCard[];
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
  clipId: string | null;
  clipSlug: string | null;
};

export type NotificationPrefs = {
  friendRequests: boolean;
  likes: boolean;
  comments: boolean;
  messages: boolean;
};

export type NotificationPrefsResponse = NotificationPrefs;

export type PatchNotificationPrefsBody = Partial<NotificationPrefs>;

export type PushTokenBody = {
  token: string;
  platform?: "ios" | "android";
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
