import { readApiJson } from "./http";
import { apiUrl } from "./supabase";
import type { SocialUser } from "./api.friends";
import { personName } from "./api.friends";

/**
 * Frozen Worker JSON contract for DMs, groups, and notifications.
 * Copied from worker/src/social-types.ts — no monorepo package.
 */

export type ConversationType = "dm" | "group";
export type ConversationRole = "owner" | "member";
export type NotificationKind = "friend_request" | "friend_accept" | "message" | "group_invite";

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

function authHeaders(accessToken?: string | null): HeadersInit {
  const headers: Record<string, string> = { accept: "application/json" };
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  return headers;
}

async function readJson<T>(response: Response, fallback: string): Promise<T> {
  return readApiJson<T>(response, fallback);
}

export async function fetchConversations(accessToken: string): Promise<ConversationSummary[]> {
  const response = await fetch(apiUrl("/v1/conversations"), { headers: authHeaders(accessToken) });
  const body = await readJson<ConversationsResponse>(response, "Could not load messages.");
  return body.conversations ?? [];
}

export async function fetchConversation(accessToken: string, conversationId: string): Promise<ConversationSummary> {
  const response = await fetch(apiUrl(`/v1/conversations/${conversationId}`), {
    headers: authHeaders(accessToken),
  });
  const body = await readJson<ConversationResponse>(response, "That conversation was not found.");
  return body.conversation;
}

export async function createConversation(
  accessToken: string,
  body: CreateConversationBody,
): Promise<ConversationSummary> {
  const response = await fetch(apiUrl("/v1/conversations"), {
    method: "POST",
    headers: { ...authHeaders(accessToken), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await readJson<ConversationResponse>(response, "Could not start that chat.");
  return payload.conversation;
}

export async function addConversationMembers(
  accessToken: string,
  conversationId: string,
  body: AddMembersBody,
): Promise<ConversationSummary> {
  const response = await fetch(apiUrl(`/v1/conversations/${conversationId}/members`), {
    method: "POST",
    headers: { ...authHeaders(accessToken), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await readJson<ConversationResponse>(response, "Could not invite that friend.");
  return payload.conversation;
}

export async function leaveConversation(accessToken: string, conversationId: string): Promise<void> {
  const response = await fetch(apiUrl(`/v1/conversations/${conversationId}/members`), {
    method: "DELETE",
    headers: authHeaders(accessToken),
  });
  await readJson<{ ok?: boolean }>(response, "Could not leave that group.");
}

export async function fetchMessages(accessToken: string, conversationId: string): Promise<ChatMessage[]> {
  const response = await fetch(apiUrl(`/v1/conversations/${conversationId}/messages`), {
    headers: authHeaders(accessToken),
  });
  const body = await readJson<MessagesResponse>(response, "Could not load that thread.");
  return body.messages ?? [];
}

export async function postMessage(
  accessToken: string,
  conversationId: string,
  body: PostMessageBody,
): Promise<ChatMessage> {
  const response = await fetch(apiUrl(`/v1/conversations/${conversationId}/messages`), {
    method: "POST",
    headers: { ...authHeaders(accessToken), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await readJson<{ message: ChatMessage }>(response, "Could not send that message.");
  return payload.message;
}

export function conversationPeer(conversation: ConversationSummary, myId: string) {
  return conversation.members.find((member) => member.id !== myId) ?? conversation.members[0] ?? null;
}

export function conversationTitle(conversation: ConversationSummary, myId: string): string {
  if (conversation.type === "group") {
    const named = conversation.title?.trim();
    if (named) return named;
    const others = conversation.members.filter((member) => member.id !== myId).map(personName);
    return others.join(", ") || "Group";
  }
  const other = conversationPeer(conversation, myId);
  return other ? personName(other) : "Direct message";
}

export function lastMessagePreview(message: ChatMessage | null): string {
  if (!message) return "No messages yet";
  const text = message.body?.trim();
  if (text) return text;
  if (message.clip) return message.clip.title || "Sent a clip";
  return "No messages yet";
}

export async function sendClipToConversation(
  accessToken: string,
  slug: string,
  body: SendClipBody,
): Promise<SendClipResponse> {
  const response = await fetch(apiUrl(`/v1/clips/${encodeURIComponent(slug)}/send`), {
    method: "POST",
    headers: { ...authHeaders(accessToken), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return readJson<SendClipResponse>(response, "Could not send that clip.");
}
