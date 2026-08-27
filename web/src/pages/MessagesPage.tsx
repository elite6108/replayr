import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ClipThumb } from "../components/ClipThumb";
import { Seo } from "../components/Seo";
import { SocialAvatar } from "../components/SocialAvatar";
import { fetchFriends, personName, type Friend } from "../lib/api.friends";
import {
  addConversationMembers,
  conversationPeer,
  conversationTitle,
  createConversation,
  fetchConversation,
  fetchConversations,
  fetchMessages,
  lastMessagePreview,
  leaveConversation,
  postMessage,
  type ChatMessage,
  type ConversationSummary,
} from "../lib/api.messages";
import { useAuth } from "../lib/auth";
import { useSocialUnread } from "../lib/socialUnread";
import { formatClipDate, formatDurationMs } from "../lib/format";
import { getSupabase, supabaseConfigured } from "../lib/supabase";

function mergeById(current: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const map = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) map.set(item.id, item);
  return [...map.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function MessagesPage() {
  const { id = "" } = useParams();
  const { session } = useAuth();
  const navigate = useNavigate();
  const token = session?.access_token ?? "";
  const myId = session?.user.id ?? "";
  const { setActiveConversation, markConversationRead } = useSocialUnread();
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [friends, setFriends] = useState<Friend[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [threadBusy, setThreadBusy] = useState(false);
  const [threadMissing, setThreadMissing] = useState(false);
  const [composingGroup, setComposingGroup] = useState(false);
  const [groupTitle, setGroupTitle] = useState("");
  const [groupPicks, setGroupPicks] = useState<string[]>([]);
  const [inviting, setInviting] = useState(false);
  const [inviteId, setInviteId] = useState("");
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  const active = useMemo(
    () => conversations.find((item) => item.id === id) ?? null,
    [conversations, id],
  );

  async function loadLists() {
    const [nextConversations, nextFriends] = await Promise.all([fetchConversations(token), fetchFriends(token)]);
    setConversations(nextConversations);
    setFriends(nextFriends);
    return nextConversations;
  }

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    setLoading(true);
    void loadLists()
      .catch((caught) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Could not load messages.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    if (!token || !id) {
      setMessages([]);
      setThreadMissing(false);
      setActiveConversation(null);
      return;
    }
    let cancelled = false;
    setThreadBusy(true);
    setThreadMissing(false);
    void (async () => {
      try {
        const [thread, conversation] = await Promise.all([
          fetchMessages(token, id),
          fetchConversation(token, id).catch(() => null),
        ]);
        if (cancelled) return;
        setMessages(thread);
        if (conversation) {
          setConversations((current) => upsertConversation({ ...conversation, unreadCount: 0 }, current));
        } else {
          setConversations((current) =>
            current.map((item) => (item.id === id ? { ...item, unreadCount: 0 } : item)),
          );
        }
        setActiveConversation(id);
        markConversationRead(id);
      } catch (caught) {
        if (!cancelled) {
          setMessages([]);
          setThreadMissing(true);
          setError(caught instanceof Error ? caught.message : "That conversation was not found.");
        }
      } finally {
        if (!cancelled) setThreadBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, token]);

  // Open threads only refreshed on focus before — subscribe so peers appear live.
  useEffect(() => {
    if (!token || !myId || !supabaseConfigured()) return;
    const supabase = getSupabase();
    const channel = supabase
      .channel(`messages-live:${myId}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" }, (payload) => {
        const row = payload.new as {
          id?: string;
          conversation_id?: string;
          sender_id?: string;
        };
        const conversationKey = row.conversation_id;
        if (!conversationKey || !row.id) return;

        if (id === conversationKey) {
          void Promise.all([
            fetchMessages(token, conversationKey),
            fetchConversation(token, conversationKey).catch(() => null),
          ])
            .then(([thread, summary]) => {
              setMessages((current) => mergeById(current, thread));
              markConversationRead(conversationKey);
              if (summary) {
                setConversations((current) =>
                  upsertConversation(
                    {
                      ...summary,
                      lastMessage: thread[thread.length - 1] ?? summary.lastMessage,
                      unreadCount: 0,
                    },
                    current,
                  ),
                );
              }
            })
            .catch(() => undefined);
          return;
        }

        if (row.sender_id === myId) return;
        void fetchConversation(token, conversationKey)
          .then((summary) => {
            setConversations((current) =>
              upsertConversation({ ...summary, unreadCount: Math.max(1, summary.unreadCount) }, current),
            );
          })
          .catch(() => undefined);
      })
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [token, myId, id, markConversationRead]);

  useEffect(() => {
    const node = scrollerRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages, id]);

  useEffect(() => {
    if (!token) return;
    function onFocus() {
      void loadLists().catch(() => undefined);
      if (id) {
        void fetchMessages(token, id)
          .then(setMessages)
          .catch(() => undefined);
      }
    }
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [token, id]);

  async function send(event: FormEvent) {
    event.preventDefault();
    const body = draft.trim();
    if (!id || !body || threadBusy) return;
    setThreadBusy(true);
    setError(null);
    try {
      const message = await postMessage(token, id, { body });
      const base = active ?? (await fetchConversation(token, id));
      setDraft("");
      setMessages((current) => [...current, message]);
      setConversations((current) =>
        upsertConversation(
          {
            ...base,
            lastMessage: message,
            updatedAt: message.createdAt,
            unreadCount: 0,
          },
          current,
        ),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not send that message.");
    } finally {
      setThreadBusy(false);
    }
  }

  async function startGroup(event: FormEvent) {
    event.preventDefault();
    if (groupPicks.length < 1) return;
    setThreadBusy(true);
    setError(null);
    try {
      const conversation = await createConversation(token, {
        type: "group",
        title: groupTitle.trim() || null,
        memberIds: groupPicks,
      });
      setComposingGroup(false);
      setGroupTitle("");
      setGroupPicks([]);
      setConversations((current) => upsertConversation(conversation, current));
      navigate(`/messages/${conversation.id}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create that group.");
    } finally {
      setThreadBusy(false);
    }
  }

  async function inviteFriend(event: FormEvent) {
    event.preventDefault();
    if (!id || !inviteId) return;
    setThreadBusy(true);
    setError(null);
    try {
      const conversation = await addConversationMembers(token, id, { userId: inviteId });
      setConversations((current) => upsertConversation(conversation, current));
      setInviting(false);
      setInviteId("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not invite that friend.");
    } finally {
      setThreadBusy(false);
    }
  }

  const inviteable = friends.filter((friend) => !active?.members.some((member) => member.id === friend.id));
  const title = active ? conversationTitle(active, myId) : "Messages";
  const peer = active ? conversationPeer(active, myId) : null;

  return (
    <main className={`page messages-page${id ? " has-thread" : ""}`}>
      <Seo title={`${id ? `${title} · ` : ""}Messages — Replayr`} description="Direct messages and group chats with friends." robots="noindex" />
      <div className="messages-head">
        <div>
          <p className="eyebrow">Friends only</p>
          <h1>Messages</h1>
        </div>
        <button
          className="btn"
          type="button"
          onClick={() => setComposingGroup((value) => !value)}
          disabled={friends.length === 0}
        >
          New group
        </button>
      </div>
      {friends.length === 0 && !loading ? (
        <p className="muted">
          Add a friend first — <Link to="/friends">open Friends</Link>.
        </p>
      ) : null}
      {error ? <p className="error">{error}</p> : null}

      {composingGroup ? (
        <form className="card group-compose" onSubmit={(event) => void startGroup(event)}>
          <h2>New group</h2>
          <p className="muted">Invite accepted friends only. 32 people max.</p>
          <label className="field">
            Name (optional)
            <input value={groupTitle} onChange={(event) => setGroupTitle(event.target.value)} maxLength={80} />
          </label>
          <ul className="person-list compact">
            {friends.map((friend) => (
              <li key={friend.id}>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={groupPicks.includes(friend.id)}
                    onChange={() =>
                      setGroupPicks((current) =>
                        current.includes(friend.id) ? current.filter((item) => item !== friend.id) : [...current, friend.id],
                      )
                    }
                  />
                  {personName(friend)}
                  {friend.username ? <span className="muted">@{friend.username}</span> : null}
                </label>
              </li>
            ))}
          </ul>
          <div className="row">
            <button className="btn primary" type="submit" disabled={threadBusy || groupPicks.length < 1}>
              Create group
            </button>
            <button className="btn" type="button" onClick={() => setComposingGroup(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      <div className={`messages-shell${id ? " has-thread" : ""}`}>
        <aside className="messages-list" aria-label="Conversations">
          {loading ? <p className="muted">Loading…</p> : null}
          {!loading && conversations.length === 0 ? (
            <div className="empty-bubble tight">
              <h2>No chats yet</h2>
              <p className="muted">Open a friend and start a message. Nothing is invented here.</p>
              <Link className="btn primary" to="/friends">
                Go to Friends
              </Link>
            </div>
          ) : (
            <ul className="conv-list">
              {conversations.map((conversation) => {
                const label = conversationTitle(conversation, myId);
                const other = conversationPeer(conversation, myId);
                const selected = conversation.id === id;
                return (
                  <li key={conversation.id}>
                    <Link className={`conv-item${selected ? " is-active" : ""}`} to={`/messages/${conversation.id}`}>
                      <SocialAvatar
                        name={label}
                        avatarUrl={conversation.type === "dm" ? other?.avatarUrl : null}
                      />
                      <span className="conv-copy">
                        <strong>{label}</strong>
                        <span className="muted">{lastMessagePreview(conversation.lastMessage)}</span>
                      </span>
                      {conversation.unreadCount > 0 ? <span className="unread-pip" aria-label="Unread" /> : null}
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>

        <section className="messages-thread" aria-live="polite">
          {!id ? (
            <div className="empty-bubble tight">
              <h2>Pick a conversation</h2>
              <p className="muted">Your thread opens on the right. Clip sending ships later — text works now.</p>
            </div>
          ) : threadMissing ? (
            <div className="empty-bubble tight">
              <h2>Conversation unavailable</h2>
              <p className="muted">That chat was not found, or you are no longer a member.</p>
              <Link className="btn" to="/messages">
                Back to messages
              </Link>
            </div>
          ) : (
            <>
              <header className="thread-head">
                <Link className="btn ghost thread-back" to="/messages">
                  Back
                </Link>
                <SocialAvatar
                  name={title}
                  avatarUrl={active?.type === "dm" ? peer?.avatarUrl : null}
                  size={36}
                />
                <div className="thread-title">
                  <strong>{title}</strong>
                  <span className="muted">
                    {active?.type === "group"
                      ? `${active.members.length} members`
                      : peer?.username
                        ? `@${peer.username}`
                        : "Direct message"}
                  </span>
                </div>
                {active?.type === "group" ? (
                  <div className="row">
                    <button className="btn" type="button" onClick={() => setInviting((value) => !value)}>
                      Invite
                    </button>
                    <button
                      className="btn danger"
                      type="button"
                      disabled={threadBusy}
                      onClick={() => {
                        if (!window.confirm("Leave this group?")) return;
                        void leaveConversation(token, id)
                          .then(() => {
                            setConversations((current) => current.filter((item) => item.id !== id));
                            navigate("/messages");
                          })
                          .catch((caught) => {
                            setError(caught instanceof Error ? caught.message : "Could not leave that group.");
                          });
                      }}
                    >
                      Leave
                    </button>
                  </div>
                ) : peer?.username ? (
                  <Link className="btn" to={`/u/${encodeURIComponent(peer.username)}`}>
                    Profile
                  </Link>
                ) : null}
              </header>

              {inviting && active?.type === "group" ? (
                <form className="invite-row" onSubmit={(event) => void inviteFriend(event)}>
                  <select value={inviteId} onChange={(event) => setInviteId(event.target.value)}>
                    <option value="">Choose a friend</option>
                    {inviteable.map((friend) => (
                      <option key={friend.id} value={friend.id}>
                        {personName(friend)}
                      </option>
                    ))}
                  </select>
                  <button className="btn primary" type="submit" disabled={!inviteId || threadBusy}>
                    Add
                  </button>
                </form>
              ) : null}

              <div className="thread-scroll" ref={scrollerRef}>
                {threadBusy && messages.length === 0 ? <p className="muted">Loading thread…</p> : null}
                {!threadBusy && messages.length === 0 ? (
                  <p className="muted">No messages yet. Say something.</p>
                ) : null}
                {messages.map((message) => {
                  const mine = message.senderId === myId;
                  return (
                    <article key={message.id} className={`chat-row${mine ? " is-mine" : ""}`}>
                      {!mine ? (
                        <SocialAvatar name={personName(message.sender)} avatarUrl={message.sender.avatarUrl} size={28} />
                      ) : null}
                      <div className="chat-bubble">
                        {!mine ? <strong>{personName(message.sender)}</strong> : null}
                        {message.body ? <p>{message.body}</p> : null}
                        {message.clip ? (
                          <Link className="clip-bubble" to={`/c/${message.clip.slug}`}>
                            <div className="clip-thumb">
                              <ClipThumb
                                title={message.clip.title || "Clip"}
                                thumbnailUrl={message.clip.thumbnailUrl}
                                playbackUrl={null}
                              />
                              {message.clip.durationMs ? (
                                <span className="clip-duration">{formatDurationMs(message.clip.durationMs)}</span>
                              ) : null}
                            </div>
                            <span className="clip-bubble-meta">
                              <strong>{message.clip.title || "Untitled clip"}</strong>
                              <span className="muted">{message.clip.game?.name || "Clip"}</span>
                            </span>
                          </Link>
                        ) : null}
                        <time className="muted">{formatClipDate(message.createdAt)}</time>
                      </div>
                    </article>
                  );
                })}
              </div>

              <form className="message-composer" onSubmit={(event) => void send(event)}>
                <input
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder="Write a message"
                  maxLength={2000}
                  aria-label="Message"
                />
                <button className="btn primary" type="submit" disabled={threadBusy || !draft.trim()}>
                  Send
                </button>
              </form>
            </>
          )}
        </section>
      </div>
    </main>
  );
}

function upsertConversation(next: ConversationSummary, current: ConversationSummary[]) {
  const without = current.filter((item) => item.id !== next.id);
  return [next, ...without].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
