import { useEffect, useMemo, useState } from "react";
import { SocialAvatar } from "./SocialAvatar";
import { fetchFriends } from "../../services/api.friends";
import {
  conversationTitle,
  createConversation,
  fetchConversations,
  sendClipToConversation,
} from "../../services/api.messages";
import type { ConversationSummary, Friend } from "../../services/social-types";
import { useAuthStore } from "../../stores/authStore";
import { useToastStore } from "../../stores/toastStore";

type Target =
  | { kind: "chat"; id: string; label: string; person: Friend | ConversationSummary["members"][number] }
  | { kind: "friend"; id: string; label: string; person: Friend };

export function SendClipSheet({ slug, onClose }: { slug: string; onClose: () => void }) {
  const token = useAuthStore((state) => state.session?.access_token);
  const myId = useAuthStore((state) => state.user?.id) ?? "";
  const showToast = useToastStore((state) => state.show);
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
      const { trackClipShared } = await import("../../services/analytics");
      trackClipShared({ channel: "dm", slug });
      showToast(`Sent to ${picked.label}`);
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not send that clip.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="send-overlay" role="dialog" aria-modal="true" aria-label="Send clip">
      <button type="button" className="player-backdrop" aria-label="Close" onClick={onClose} />
      <section className="send-sheet">
        <h2>Send clip</h2>
        <p className="muted">Pick a recent chat or someone you both follow. This does not make the clip public.</p>
        {error ? <p className="error-text">{error}</p> : null}
        {conversations.length === 0 && friends.length === 0 ? (
          <p className="muted">Follow people to send clips. Copy link still works from the player.</p>
        ) : (
          <>
            {conversations.length > 0 ? (
              <div className="send-group">
                <h3>Recent chats</h3>
                <ul className="person-list">
                  {conversations.map((conversation) => {
                    const label = conversationTitle(conversation, myId);
                    const person = conversation.members.find((member) => member.id !== myId) ?? conversation.members[0];
                    if (!person) return null;
                    const selected = picked?.kind === "chat" && picked.id === conversation.id;
                    return (
                      <li key={conversation.id}>
                        <button
                          className={`person-row send-pick${selected ? " is-picked" : ""}`}
                          type="button"
                          onClick={() => setPicked({ kind: "chat", id: conversation.id, label, person })}
                        >
                          <SocialAvatar person={person} size="md" />
                          <span className="person-copy">
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
                <h3>People you both follow</h3>
                <ul className="person-list">
                  {friendTargets.map((friend) => {
                    const selected = picked?.kind === "friend" && picked.id === friend.id;
                    return (
                      <li key={friend.id}>
                        <button
                          className={`person-row send-pick${selected ? " is-picked" : ""}`}
                          type="button"
                          onClick={() => setPicked({ kind: "friend", id: friend.id, label: friend.displayName, person: friend })}
                        >
                          <SocialAvatar person={friend} size="md" />
                          <span className="person-copy">
                            <strong>{friend.displayName}</strong>
                            <span className="muted">{friend.username ? `@${friend.username}` : "Following"}</span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : null}
          </>
        )}
        <div className="row">
          <button className="btn primary" type="button" disabled={!picked || busy} onClick={() => void send()}>
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
