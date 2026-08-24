import type { Href } from "expo-router";
import { readApiError, readApiJson } from "./http";
import { apiUrl } from "./supabase";
import type { SocialUser } from "./api.friends";
import { socialName } from "./api.friends";

export type ConversationType = "dm" | "group";
export type ConversationRole = "owner" | "member";

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

function authHeaders(accessToken: string): HeadersInit {
  return { accept: "application/json", authorization: `Bearer ${accessToken}` };
}

export function conversationTitle(conversation: ConversationSummary, myId?: string | null) {
  if (conversation.type === "group") {
    if (conversation.title?.trim()) return conversation.title.trim();
    const names = conversation.members
      .filter((member) => member.id !== myId)
      .map((member) => socialName(member));
    return names.length > 0 ? names.join(", ") : "Group";
  }
  const other = conversation.members.find((member) => member.id !== myId);
  return socialName(other);
}

export function conversationPeer(conversation: ConversationSummary, myId?: string | null) {
  return conversation.members.find((member) => member.id !== myId) ?? conversation.members[0] ?? null;
}

export function threadHref(conversationId: string): Href {
  return { pathname: "/messages/[id]", params: { id: conversationId } } as unknown as Href;
}

export function lastMessagePreview(message: ChatMessage | null) {
  if (!message) return "No messages yet";
  if (message.body?.trim()) return message.body.trim();
  if (message.clip) return message.clip.title || "Sent a clip";
  return "No messages yet";
}

export async function fetchConversations(accessToken: string): Promise<ConversationSummary[]> {
  const response = await fetch(apiUrl("/v1/conversations"), { headers: authHeaders(accessToken) });
  const body = await readApiJson<ConversationsResponse>(response, "Could not load messages.");
  return body.conversations ?? [];
}

export async function fetchConversation(accessToken: string, conversationId: string): Promise<ConversationSummary> {
  const response = await fetch(apiUrl(`/v1/conversations/${conversationId}`), { headers: authHeaders(accessToken) });
  const body = await readApiJson<ConversationResponse>(response, "That conversation is not available.");
  if (!body.conversation) throw new Error("That conversation is not available.");
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
  const payload = await readApiJson<ConversationResponse>(response, "Could not start that chat.");
  if (!payload.conversation) throw new Error("Could not start that chat.");
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
  const payload = await readApiJson<ConversationResponse>(response, "Could not invite that friend.");
  if (!payload.conversation) throw new Error("Could not invite that friend.");
  return payload.conversation;
}

export async function leaveConversation(accessToken: string, conversationId: string): Promise<void> {
  const response = await fetch(apiUrl(`/v1/conversations/${conversationId}/members`), {
    method: "DELETE",
    headers: authHeaders(accessToken),
  });
  if (!response.ok) throw new Error(await readApiError(response, "Could not leave that group."));
}

export async function fetchMessages(
  accessToken: string,
  conversationId: string,
  options?: { before?: string; limit?: number },
): Promise<ChatMessage[]> {
  const query = new URLSearchParams();
  if (options?.limit) query.set("limit", String(options.limit));
  if (options?.before) query.set("before", options.before);
  const suffix = query.toString() ? `?${query}` : "";
  const response = await fetch(apiUrl(`/v1/conversations/${conversationId}/messages${suffix}`), {
    headers: authHeaders(accessToken),
  });
  const body = await readApiJson<MessagesResponse>(response, "Could not load that chat.");
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
  const payload = await readApiJson<{ message?: ChatMessage }>(response, "Could not send that message.");
  if (!payload.message) throw new Error("Could not send that message.");
  return payload.message;
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
  const payload = await readApiJson<SendClipResponse>(response, "Could not send that clip.");
  if (!payload.message) throw new Error("Could not send that clip.");
  return { message: payload.message, conversationId: payload.conversationId };
}
