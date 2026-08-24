import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { AuthCard } from "../components/common/AuthCard";
import { EmptyState } from "../components/common/EmptyState";
import { PageHeader } from "../components/common/PageHeader";
import { SocialAvatar } from "../components/common/SocialAvatar";
import { IconFriends, IconSearch } from "../components/icons";
import { clipShareUrl } from "../branding";
import { fetchFriends } from "../services/api.friends";
import {
  addConversationMembers,
  createConversation,
  fetchConversation,
  fetchConversations,
  fetchMessages,
  leaveConversation,
  postMessage,
} from "../services/api.messages";
import type { ChatMessage, ConversationSummary, Friend, MessageClip, SocialUser } from "../services/social-types";
import { useAuthStore } from "../stores/authStore";
import { useSocialUnreadStore } from "../stores/socialUnreadStore";
import { useToastStore } from "../stores/toastStore";
import { formatClipDate, formatDuration } from "../utils/format";

export function MessagesPage() {
  const configured = useAuthStore((state) => state.configured);
  const user = useAuthStore((state) => state.user);
  const token = useAuthStore((state) => state.session?.access_token);
  const showToast = useToastStore((state) => state.show);
  const navigate = useNavigate();
  const { conversationId } = useParams<{ conversationId: string }>();
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [friends, setFriends] = useState<Friend[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [groupTitle, setGroupTitle] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const selected = useMemo(
    () => conversations.find((item) => item.id === conversationId) ?? null,
    [conversations, conversationId],
  );

  const loadLists = useCallback(async () => {
    if (!token) return;
    try {
      const [nextConversations, nextFriends] = await Promise.all([fetchConversations(token), fetchFriends(token)]);
      setConversations(nextConversations);
      setFriends(nextFriends);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load messages.");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void loadLists();
  }, [loadLists]);

  useEffect(() => {
    if (!token || !conversationId) {
      setMessages([]);
      setHasMore(false);
      useSocialUnreadStore.getState().setActiveConversation(null);
      return;
    }
    let cancelled = false;
    stickToBottom.current = true;
    void (async () => {
      try {
        const thread = await fetchMessages(token, conversationId);
        if (cancelled) return;
        setMessages(thread);
        setHasMore(thread.length >= 50);
        setConversations((current) => {
          if (current.some((item) => item.id === conversationId)) {
            return current.map((item) =>
              item.id === conversationId
                ? { ...item, unreadCount: 0, lastMessage: thread[thread.length - 1] ?? item.lastMessage }
                : item,
            );
          }
          return current;
        });
        useSocialUnreadStore.getState().setActiveConversation(conversationId);
        useSocialUnreadStore.getState().markConversationRead(conversationId);
      } catch (caught) {
        if (!cancelled) showToast(caught instanceof Error ? caught.message : "Could not open that chat.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId, token, showToast]);

  useEffect(() => {
    if (!token || !conversationId) return;
    if (conversations.some((item) => item.id === conversationId)) return;
    let cancelled = false;
    void fetchConversation(token, conversationId)
      .then((summary) => {
        if (cancelled) return;
        setConversations((current) => (current.some((item) => item.id === summary.id) ? current : [summary, ...current]));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [conversationId, token, conversations]);

  useEffect(() => {
    if (!stickToBottom.current) return;
    const node = scroller.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages, conversationId]);

  async function send(event: FormEvent) {
    event.preventDefault();
    if (!token || !conversationId) return;
    const body = draft.trim();
    if (!body) return;
    setSending(true);
    setDraft("");
    try {
      const message = await postMessage(token, conversationId, { body });
      stickToBottom.current = true;
      setMessages((current) => [...current, message]);
      setConversations((current) => {
        const rest = current.filter((item) => item.id !== conversationId);
        const mine = current.find((item) => item.id === conversationId);
        if (!mine) return current;
        return [{ ...mine, lastMessage: message, updatedAt: message.createdAt, unreadCount: 0 }, ...rest];
      });
    } catch (caught) {
      setDraft(body);
      showToast(caught instanceof Error ? caught.message : "Could not send that message.");
    } finally {
      setSending(false);
    }
  }

  async function loadEarlier() {
    const oldest = messages[0];
    if (!token || !conversationId || !oldest) return;
    try {
      const older = await fetchMessages(token, conversationId, { before: oldest.id, limit: 50 });
      if (older.length === 0) {
        setHasMore(false);
        showToast("No earlier messages");
        return;
      }
      stickToBottom.current = false;
      setHasMore(older.length >= 50);
      setMessages((current) => [...older, ...current]);
    } catch (caught) {
      showToast(caught instanceof Error ? caught.message : "Could not load earlier messages.");
    }
  }

  async function startGroup() {
    if (!token || picked.length === 0) return;
    try {
      const conversation = await createConversation(token, {
        type: "group",
        title: groupTitle.trim() || null,
        memberIds: picked,
      });
      setCreatingGroup(false);
      setGroupTitle("");
      setPicked([]);
      setConversations((current) => [conversation, ...current.filter((item) => item.id !== conversation.id)]);
      navigate(`/messages/${conversation.id}`);
    } catch (caught) {
      showToast(caught instanceof Error ? caught.message : "Could not create that group.");
    }
  }

  async function invitePicked() {
    if (!token || !conversationId || picked.length === 0) return;
    try {
      const conversation = await addConversationMembers(token, conversationId, { userIds: picked });
      setInviting(false);
      setPicked([]);
      setConversations((current) => current.map((item) => (item.id === conversation.id ? conversation : item)));
      showToast("Invited");
    } catch (caught) {
      showToast(caught instanceof Error ? caught.message : "Could not invite that friend.");
    }
  }

  async function leaveGroup() {
    if (!token || !conversationId || selected?.type !== "group") return;
    if (!window.confirm("Leave this group?")) return;
    try {
      await leaveConversation(token, conversationId);
      setConversations((current) => current.filter((item) => item.id !== conversationId));
      navigate("/messages");
    } catch (caught) {
      showToast(caught instanceof Error ? caught.message : "Could not leave that group.");
    }
  }

  if (!configured) {
    return (
      <>
        <PageHeader title="Messages" subtitle="Cloud accounts are not configured on this PC." />
        <section className="panel">
          <p>
            Copy <code>.env.example</code> to <code>.env</code> and set <code>VITE_SUPABASE_URL</code> and{" "}
            <code>VITE_SUPABASE_ANON_KEY</code>.
          </p>
        </section>
      </>
    );
  }

  if (!user || !token) {
    return (
      <>
        <PageHeader title="Messages" subtitle="Sign in to message friends. Capture still works offline." />
        <AuthCard />
      </>
    );
  }

  const inviteable = friends.filter((friend) => !selected?.members.some((member) => member.id === friend.id));

  return (
    <div className="social-page social-fill">
      <PageHeader title="Messages" subtitle="Direct messages and groups with accepted friends.">
        <button className="btn" type="button" onClick={() => { setCreatingGroup(true); setInviting(false); setPicked([]); }}>
          New group
        </button>
      </PageHeader>

      {error ? <p className="error-text">{error}</p> : null}

      <div className="messages-shell">
        <section className="panel conv-pane">
          {loading && conversations.length === 0 ? <p className="muted">Loading chats…</p> : null}
          {!loading && conversations.length === 0 ? (
            <EmptyState
              icon={<IconFriends size={26} />}
              title="No conversations yet"
              body="Message a friend from the Friends page, or create a group. Empty inboxes stay empty until someone writes."
            />
          ) : (
            <ul className="conv-list">
              {conversations.map((conversation) => {
                const peer = conversationPeer(conversation, user.id);
                const preview = lastMessagePreview(conversation.lastMessage);
                return (
                  <li key={conversation.id}>
                    <button
                      className={`conv-item ${conversation.id === conversationId ? "active" : ""}`}
                      type="button"
                      onClick={() => navigate(`/messages/${conversation.id}`)}
                    >
                      <span className="conv-avatar">
                        <SocialAvatar person={peer} size="md" />
                        {conversation.unreadCount > 0 ? <span className="unread-pip" /> : null}
                      </span>
                      <span className="conv-copy">
                        <strong>{conversationTitle(conversation, user.id)}</strong>
                        <span className="muted">{preview}</span>
                      </span>
                      <span className="muted conv-time">{conversation.lastMessage ? formatClipDate(conversation.lastMessage.createdAt) : ""}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="panel thread-pane">
          {!conversationId ? (
            <EmptyState
              icon={<IconSearch size={26} />}
              title="Choose a conversation"
              body="Pick a chat on the left. Clip sending from the player ships later — text works now."
            />
          ) : !selected ? (
            <p className="muted">Opening chat…</p>
          ) : (
            <>
              <header className="thread-head">
                <div className="row">
                  <SocialAvatar person={conversationPeer(selected, user.id)} size="md" />
                  <div>
                    <strong>{conversationTitle(selected, user.id)}</strong>
                    <div className="muted">
                      {selected.type === "group"
                        ? selected.members.map((member) => member.displayName).join(", ")
                        : "Direct message"}
                    </div>
                  </div>
                </div>
                {selected.type === "group" ? (
                  <div className="row">
                    <button className="btn sm" type="button" onClick={() => { setInviting(true); setCreatingGroup(false); setPicked([]); }}>
                      Invite
                    </button>
                    <button className="btn sm danger" type="button" onClick={() => void leaveGroup()}>
                      Leave
                    </button>
                  </div>
                ) : null}
              </header>
              <div
                className="thread-scroll"
                ref={scroller}
                onScroll={(event) => {
                  const node = event.currentTarget;
                  stickToBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
                }}
              >
                {hasMore ? (
                  <button className="btn ghost sm thread-earlier" type="button" onClick={() => void loadEarlier()}>
                    Load earlier
                  </button>
                ) : null}
                {messages.length === 0 ? (
                  <p className="muted thread-empty">No messages yet. Say hello.</p>
                ) : (
                  messages.map((message) => {
                    const mine = message.senderId === user.id;
                    return (
                      <article key={message.id} className={`bubble-row ${mine ? "mine" : ""}`}>
                        {!mine ? <SocialAvatar person={message.sender} size="sm" /> : null}
                        <div className={`bubble ${mine ? "mine" : ""}`}>
                          {!mine ? <span className="bubble-name">{message.sender.displayName}</span> : null}
                          {message.body ? <p>{message.body}</p> : null}
                          {message.clip ? <ClipBubble clip={message.clip} /> : null}
                          <time className="muted">{formatClipDate(message.createdAt)}</time>
                        </div>
                      </article>
                    );
                  })
                )}
              </div>
              <form className="composer" onSubmit={(event) => void send(event)}>
                <input
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder="Write a message"
                  aria-label="Message"
                  maxLength={2000}
                  disabled={sending}
                />
                <button className="btn primary" type="submit" disabled={sending || !draft.trim()}>
                  Send
                </button>
              </form>
            </>
          )}
        </section>
      </div>

      {creatingGroup || inviting ? (
        <div className="social-modal" role="dialog" aria-modal="true">
          <section className="panel stack social-modal-card">
            <div className="panel-head">
              <h2>{creatingGroup ? "New group" : "Invite friends"}</h2>
              <button
                className="btn sm"
                type="button"
                onClick={() => {
                  setCreatingGroup(false);
                  setInviting(false);
                  setPicked([]);
                }}
              >
                Close
              </button>
            </div>
            {creatingGroup ? (
              <div className="field">
                <label htmlFor="group-title">Group name</label>
                <input
                  id="group-title"
                  value={groupTitle}
                  onChange={(event) => setGroupTitle(event.target.value)}
                  placeholder="Optional"
                  maxLength={64}
                />
              </div>
            ) : null}
            {(creatingGroup ? friends : inviteable).length === 0 ? (
              <p className="muted">
                {creatingGroup ? "Add a friend first, then you can start a group." : "Every friend is already in this group."}
              </p>
            ) : (
              <ul className="person-list picker">
                {(creatingGroup ? friends : inviteable).map((friend) => {
                  const on = picked.includes(friend.id);
                  return (
                    <li key={friend.id}>
                      <label className="person-row picker-row">
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() =>
                            setPicked((current) => (on ? current.filter((id) => id !== friend.id) : [...current, friend.id]))
                          }
                        />
                        <SocialAvatar person={friend} />
                        <span>{friend.displayName}</span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
            <button
              className="btn primary"
              type="button"
              disabled={picked.length === 0}
              onClick={() => void (creatingGroup ? startGroup() : invitePicked())}
            >
              {creatingGroup ? "Create group" : "Invite"}
            </button>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function conversationPeer(conversation: ConversationSummary, me: string): SocialUser {
  if (conversation.type === "group") {
    return {
      id: conversation.id,
      username: null,
      displayName: conversation.title || "Group",
      avatarUrl: null,
      verified: false,
    };
  }
  return conversation.members.find((member) => member.id !== me) ?? conversation.members[0] ?? {
    id: me,
    username: null,
    displayName: "Direct message",
    avatarUrl: null,
    verified: false,
  };
}

function conversationTitle(conversation: ConversationSummary, me: string) {
  if (conversation.title) return conversation.title;
  if (conversation.type === "group") {
    const others = conversation.members.filter((member) => member.id !== me).map((member) => member.displayName);
    return others.join(", ") || "Group";
  }
  const peer = conversationPeer(conversation, me);
  return peer.displayName || peer.username || "Direct message";
}

function lastMessagePreview(message: ChatMessage | null) {
  if (!message) return "No messages yet";
  if (message.body) return message.body;
  if (message.clip) return message.clip.title || "Sent a clip";
  return "Message";
}

function ClipBubble({ clip }: { clip: MessageClip }) {
  return (
    <a className="clip-bubble" href={clipShareUrl(clip.slug)} target="_blank" rel="noreferrer">
      <span className="clip-bubble-thumb">
        {clip.thumbnailUrl ? <img src={clip.thumbnailUrl} alt="" /> : <span className="feed-thumb-empty" />}
        {clip.durationMs ? <span className="clip-duration">{formatDuration(clip.durationMs)}</span> : null}
      </span>
      <strong>{clip.title || "Untitled clip"}</strong>
      <span className="muted">{clip.game?.name || "Clip"}</span>
    </a>
  );
}
