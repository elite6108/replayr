import { useEffect, useId, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { SocialAvatar } from "./SocialAvatar";
import {
  acceptFriendRequest,
  declineFriendRequest,
  fetchFriendRequests,
  personName,
} from "../lib/api.friends";
import {
  fetchNotifications,
  readNotifications,
  type NotificationItem,
} from "../lib/api.messages";
import { useAuth } from "../lib/auth";
import { formatTimeAgo } from "../lib/format";
import { useSocialUnread } from "../lib/socialUnread";

function copyFor(item: NotificationItem) {
  const name = personName(item.actor ?? { displayName: "Someone", username: null });
  if (item.kind === "friend_request" || item.kind === "follow_request") return `${name} requested to follow you`;
  if (item.kind === "friend_accept" || item.kind === "follow_accept") return `${name} accepted your follow request`;
  if (item.kind === "group_invite") return `${name} invited you to a group`;
  if (item.kind === "folder_invite") return `${name} invited you to a folder`;
  if (item.kind === "folder_invite_accepted") return `${name} accepted your folder invite`;
  return `${name} sent you a message`;
}

export function NotificationBell() {
  const { session } = useAuth();
  const token = session?.access_token;
  const navigate = useNavigate();
  const { notificationsUnread, setNotificationsUnread, setFriendsUnread } = useSocialUnread();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  useEffect(() => {
    if (!open || !token) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void fetchNotifications(token)
      .then(async (notifications) => {
        if (cancelled) return;
        setItems(notifications);
        const unreadIds = notifications.filter((item) => !item.readAt).map((item) => item.id);
        setNotificationsUnread(0);
        if (unreadIds.length > 0) {
          await readNotifications(token, unreadIds).catch(() => undefined);
        }
      })
      .catch((caught) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Could not load notifications.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, token, setNotificationsUnread]);

  if (!token) return null;
  const accessToken = token;

  async function refreshFriendsFlag() {
    const requests = await fetchFriendRequests(accessToken).catch(() => ({ incoming: [], outgoing: [] }));
    setFriendsUnread(requests.incoming.length > 0);
  }

  async function onAccept(item: NotificationItem) {
    if (!item.friendshipId) return;
    setBusyId(item.id);
    try {
      await acceptFriendRequest(accessToken, item.friendshipId);
      setItems((current) => current.filter((row) => row.id !== item.id));
      await refreshFriendsFlag();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not accept that request.");
    } finally {
      setBusyId(null);
    }
  }

  async function onDecline(item: NotificationItem) {
    if (!item.friendshipId) return;
    setBusyId(item.id);
    try {
      await declineFriendRequest(accessToken, item.friendshipId);
      setItems((current) => current.filter((row) => row.id !== item.id));
      await refreshFriendsFlag();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not decline that request.");
    } finally {
      setBusyId(null);
    }
  }

  function openItem(item: NotificationItem) {
    setOpen(false);
    if (item.kind === "friend_request") {
      navigate("/friends?tab=requests");
      return;
    }
    if (item.kind === "friend_accept" && item.actor?.username) {
      navigate(`/u/${item.actor.username}`);
      return;
    }
    if ((item.kind === "message" || item.kind === "group_invite") && item.conversationId) {
      navigate(`/messages/${item.conversationId}`);
    }
  }

  return (
    <div className="header-popover-wrap" ref={wrapRef}>
      <button
        className="header-icon-btn"
        type="button"
        aria-label={notificationsUnread > 0 ? `${notificationsUnread} unread notifications` : "Notifications"}
        aria-expanded={open}
        aria-haspopup="true"
        aria-controls={menuId}
        onClick={() => setOpen((value) => !value)}
      >
        <BellIcon />
        {notificationsUnread > 0 ? <span className="unread-pip header-icon-pip" aria-hidden="true" /> : null}
      </button>
      {open ? (
        <div className="header-popover" id={menuId} role="dialog" aria-label="Notifications">
          <div className="header-popover-head">
            <strong>Notifications</strong>
            <Link to="/friends?tab=requests" onClick={() => setOpen(false)}>
              View all
            </Link>
          </div>
          {error ? <p className="error">{error}</p> : null}
          {loading ? (
            <p className="muted">Loading…</p>
          ) : items.length === 0 ? (
            <p className="muted">You’re all caught up.</p>
          ) : (
            <ul className="header-popover-list">
              {items.map((item) => {
                const name = personName(item.actor ?? { displayName: "Someone", username: null });
                const busy = busyId === item.id;
                return (
                  <li key={item.id} className="header-popover-item">
                    <button className="header-popover-main" type="button" onClick={() => openItem(item)}>
                      <SocialAvatar name={name} avatarUrl={item.actor?.avatarUrl ?? null} size={36} />
                      <span>
                        <strong>{copyFor(item)}</strong>
                        <span className="muted">{formatTimeAgo(item.createdAt)}</span>
                      </span>
                    </button>
                    {item.kind === "friend_request" && item.friendshipId ? (
                      <div className="header-popover-actions">
                        <button className="btn primary sm" type="button" disabled={busy} onClick={() => void onAccept(item)}>
                          {busy ? "…" : "Accept"}
                        </button>
                        <button className="btn sm" type="button" disabled={busy} onClick={() => void onDecline(item)}>
                          Decline
                        </button>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

function BellIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10 21a2 2 0 0 0 4 0" />
    </svg>
  );
}
