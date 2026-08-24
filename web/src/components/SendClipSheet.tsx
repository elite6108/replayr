import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { fetchFriends, personName, type Friend } from "../lib/api.friends";
import {
  conversationTitle,
  createConversation,
  fetchConversations,
  sendClipToConversation,
  type ConversationSummary,
} from "../lib/api.messages";
import { useAuth } from "../lib/auth";
import { SocialAvatar } from "./SocialAvatar";

type Target =
  | { kind: "chat"; id: string; label: string }
  | { kind: "friend"; id: string; label: string };

export function SendClipSheet({ slug, onClose }: { slug: string; onClose: () => void }) {
  const { session } = useAuth();
  const token = session?.access_token;
  const myId = session?.user.id ?? "";
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [friends, setFriends] = useState<Friend[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<Target | null>(null);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    void Promise.all([fetchConversations(token), fetchFriends(token)])
      .then(([nextConversations, nextFriends]) => {
        if (cancelled) return;
        setConversations(nextConversations);
        setFriends(nextFriends);
      })
      .catch((caught) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Could not load people to send to.");
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const friendTargets = useMemo(() => {
    const shown = new Set(conversations.map((item) => item.id));
    return friends.filter((friend) => !friend.dmId || !shown.has(friend.dmId));
  }, [conversations, friends]);

  async function send() {
    if (!token || !picked) return;
    setBusy(true);
    setError(null);
    try {
      const conversationId =
        picked.kind === "chat"
          ? picked.id
          : friends.find((friend) => friend.id === picked.id)?.dmId ??
            (await createConversation(token, { type: "dm", userId: picked.id })).id;
      await sendClipToConversation(token, slug, { conversationId });
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not send that clip.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="send-overlay" role="dialog" aria-modal="true" aria-label="Send clip">
      <button type="button" className="send-backdrop" aria-label="Close" onClick={onClose} />
      <section className="send-sheet">
        <h2>Send clip</h2>
        <p className="muted">Pick a recent chat or a friend. Sending does not make the clip public.</p>
        {error ? <p className="error">{error}</p> : null}
        {!token ? (
          <p className="muted">
            <Link to="/signin">Sign in</Link> to send this clip. Copy link still works.
          </p>
        ) : conversations.length === 0 && friends.length === 0 ? (
          <p className="muted">
            Add friends to send clips. <Link to="/friends">Find people</Link>
          </p>
        ) : (
          <>
            {conversations.length > 0 ? (
              <div className="send-group">
                <h3>Recent chats</h3>
                <ul className="person-list">
                  {conversations.map((conversation) => {
                    const label = conversationTitle(conversation, myId);
                    const person = conversation.members.find((member) => member.id !== myId) ?? conversation.members[0];
                    return (
                      <li key={conversation.id}>
                        <button
                          className={`person-row send-pick${picked?.kind === "chat" && picked.id === conversation.id ? " is-picked" : ""}`}
                          type="button"
                          onClick={() => setPicked({ kind: "chat", id: conversation.id, label })}
                        >
                          <SocialAvatar name={person ? personName(person) : label} avatarUrl={person?.avatarUrl} />
                          <span>
                            <strong>{label}</strong>
                            <span className="muted">{conversation.type === "group" ? "Group" : "Chat"}</span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : null}
            {friendTargets.length > 0 ? (
              <div className="send-group">
                <h3>Friends</h3>
                <ul className="person-list">
                  {friendTargets.map((friend) => (
                    <li key={friend.id}>
                      <button
                        className={`person-row send-pick${picked?.kind === "friend" && picked.id === friend.id ? " is-picked" : ""}`}
                        type="button"
                        onClick={() => setPicked({ kind: "friend", id: friend.id, label: personName(friend) })}
                      >
                        <SocialAvatar name={personName(friend)} avatarUrl={friend.avatarUrl} />
                        <span>
                          <strong>{personName(friend)}</strong>
                          <span className="muted">{friend.username ? `@${friend.username}` : "Friend"}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        )}
        <div className="row">
          <button className="btn primary" type="button" disabled={!token || !picked || busy} onClick={() => void send()}>
            {busy ? "Sending…" : picked ? `Send to ${picked.label}` : "Pick someone"}
          </button>
          <button className="btn" type="button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </section>
    </div>
  );
}
