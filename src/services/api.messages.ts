import { publicApiUrl } from "../branding";
import { readApiJson } from "../utils/http";
import type {
  AddMembersBody,
  ChatMessage,
  ConversationResponse,
  ConversationSummary,
  ConversationsResponse,
  CreateConversationBody,
  MessagesResponse,
  PostMessageBody,
  SendClipBody,
  SendClipResponse,
} from "./social-types";

function authHeaders(accessToken: string, json = false): HeadersInit {
  const headers: Record<string, string> = {
    accept: "application/json",
    authorization: `Bearer ${accessToken}`,
  };
  if (json) headers["content-type"] = "application/json";
  return headers;
}

async function readApi<T>(response: Response, fallback: string): Promise<T> {
  return readApiJson<T>(response, fallback);
}

export async function fetchConversations(accessToken: string): Promise<ConversationSummary[]> {
  const response = await fetch(`${publicApiUrl()}/v1/conversations`, {
    headers: authHeaders(accessToken),
  });
  const body = await readApi<ConversationsResponse>(response, "Could not load conversations.");
  return body.conversations ?? [];
}

export async function fetchConversation(accessToken: string, conversationId: string): Promise<ConversationSummary> {
  const response = await fetch(`${publicApiUrl()}/v1/conversations/${conversationId}`, {
    headers: authHeaders(accessToken),
  });
  const body = await readApi<ConversationResponse>(response, "That conversation was not found.");
  return body.conversation;
}

export async function createConversation(accessToken: string, payload: CreateConversationBody): Promise<ConversationSummary> {
  const response = await fetch(`${publicApiUrl()}/v1/conversations`, {
    method: "POST",
    headers: authHeaders(accessToken, true),
    body: JSON.stringify(payload),
  });
  const body = await readApi<ConversationResponse>(response, "Could not start that conversation.");
  return body.conversation;
}

export async function addConversationMembers(
  accessToken: string,
  conversationId: string,
  payload: AddMembersBody,
): Promise<ConversationSummary> {
  const response = await fetch(`${publicApiUrl()}/v1/conversations/${conversationId}/members`, {
    method: "POST",
    headers: authHeaders(accessToken, true),
    body: JSON.stringify(payload),
  });
  const body = await readApi<ConversationResponse>(response, "Could not invite that person.");
  return body.conversation;
}

export async function leaveConversation(accessToken: string, conversationId: string): Promise<void> {
  const response = await fetch(`${publicApiUrl()}/v1/conversations/${conversationId}/members`, {
    method: "DELETE",
    headers: authHeaders(accessToken),
  });
  await readApi<{ ok?: boolean }>(response, "Could not leave that group.");
}

export async function fetchMessages(
  accessToken: string,
  conversationId: string,
  opts?: { before?: string; limit?: number },
): Promise<ChatMessage[]> {
  const params = new URLSearchParams();
  if (opts?.before) params.set("before", opts.before);
  if (opts?.limit) params.set("limit", String(opts.limit));
  const query = params.toString();
  const suffix = query ? `?${query}` : "";
  const response = await fetch(`${publicApiUrl()}/v1/conversations/${conversationId}/messages${suffix}`, {
    headers: authHeaders(accessToken),
  });
  const body = await readApi<MessagesResponse>(response, "Could not load messages.");
  return body.messages ?? [];
}

export async function postMessage(
  accessToken: string,
  conversationId: string,
  payload: PostMessageBody,
): Promise<ChatMessage> {
  const response = await fetch(`${publicApiUrl()}/v1/conversations/${conversationId}/messages`, {
    method: "POST",
    headers: authHeaders(accessToken, true),
    body: JSON.stringify(payload),
  });
  const body = await readApi<{ message: ChatMessage }>(response, "Could not send that message.");
  return body.message;
}

export async function sendClipToConversation(
  accessToken: string,
  slug: string,
  payload: SendClipBody,
): Promise<SendClipResponse> {
  const response = await fetch(`${publicApiUrl()}/v1/clips/${encodeURIComponent(slug)}/send`, {
    method: "POST",
    headers: authHeaders(accessToken, true),
    body: JSON.stringify(payload),
  });
  return readApi<SendClipResponse>(response, "Could not send that clip.");
}

export function conversationPeer(conversation: ConversationSummary, myId: string) {
  return conversation.members.find((member) => member.id !== myId) ?? conversation.members[0] ?? null;
}

export function conversationTitle(conversation: ConversationSummary, myId: string): string {
  if (conversation.type === "group") {
    const named = conversation.title?.trim();
    if (named) return named;
    const others = conversation.members.filter((member) => member.id !== myId).map((member) => member.displayName);
    return others.join(", ") || "Group";
  }
  const other = conversationPeer(conversation, myId);
  return other?.displayName || other?.username || "Direct message";
}
