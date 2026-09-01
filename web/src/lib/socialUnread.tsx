import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { fetchFriendRequests } from "./api.friends";
import { fetchConversations, fetchNotifications } from "./api.messages";
import { useAuth } from "./auth";
import { getSupabase, supabaseConfigured } from "./supabase";

type UnreadValue = {
  friendsUnread: boolean;
  messagesUnread: boolean;
  notificationsUnread: number;
  setActiveConversation: (id: string | null) => void;
  markConversationRead: (id: string) => void;
  setFriendsUnread: (value: boolean) => void;
  setNotificationsUnread: (value: number) => void;
};

const UnreadContext = createContext<UnreadValue>({
  friendsUnread: false,
  messagesUnread: false,
  notificationsUnread: 0,
  setActiveConversation: () => undefined,
  markConversationRead: () => undefined,
  setFriendsUnread: () => undefined,
  setNotificationsUnread: () => undefined,
});

function isBellKind(kind?: string) {
  return (
    kind === "friend_request" ||
    kind === "friend_accept" ||
    kind === "follow_request" ||
    kind === "follow_accept" ||
    kind === "message" ||
    kind === "group_invite" ||
    kind === "folder_invite" ||
    kind === "folder_invite_accepted" ||
    kind === "folder_role_changed" ||
    kind === "folder_ownership_transferred"
  );
}

export function SocialUnreadProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const token = session?.access_token;
  const userId = session?.user.id;
  const [friendsUnread, setFriendsUnread] = useState(false);
  const [unreadIds, setUnreadIds] = useState<string[]>([]);
  const [notificationsUnread, setNotificationsUnread] = useState(0);
  const activeConversationId = useRef<string | null>(null);

  useEffect(() => {
    if (!token || !userId || !supabaseConfigured()) {
      setFriendsUnread(false);
      setUnreadIds([]);
      setNotificationsUnread(0);
      activeConversationId.current = null;
      return;
    }
    let cancelled = false;
    void Promise.all([fetchConversations(token), fetchFriendRequests(token), fetchNotifications(token)])
      .then(([conversations, requests, notifications]) => {
        if (cancelled) return;
        setFriendsUnread(requests.incoming.length > 0);
        setUnreadIds(conversations.filter((item) => item.unreadCount > 0).map((item) => item.id));
        setNotificationsUnread(notifications.filter((item) => !item.readAt).length);
      })
      .catch(() => undefined);

    const supabase = getSupabase();
    const channel = supabase
      .channel(`social-unread:${userId}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" }, (payload) => {
        const row = payload.new as { conversation_id?: string; sender_id?: string };
        if (!row.conversation_id || row.sender_id === userId) return;
        if (activeConversationId.current === row.conversation_id) return;
        setUnreadIds((current) => (current.includes(row.conversation_id!) ? current : [...current, row.conversation_id!]));
      })
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications" }, (payload) => {
        const row = payload.new as { kind?: string; conversation_id?: string | null; actor_id?: string | null };
        if (row.kind === "friend_request" || row.kind === "follow_request") setFriendsUnread(true);
        if (isBellKind(row.kind) && row.actor_id !== userId) {
          setNotificationsUnread((current) => current + 1);
        }
        if ((row.kind === "message" || row.kind === "group_invite") && row.conversation_id && row.actor_id !== userId) {
          if (activeConversationId.current === row.conversation_id) return;
          setUnreadIds((current) =>
            current.includes(row.conversation_id!) ? current : [...current, row.conversation_id!],
          );
        }
      })
      .subscribe();

    return () => {
      cancelled = true;
      void supabase.removeChannel(channel);
    };
  }, [token, userId]);

  const setActiveConversation = useCallback((id: string | null) => {
    activeConversationId.current = id;
  }, []);
  const markConversationRead = useCallback((id: string) => {
    setUnreadIds((current) => current.filter((item) => item !== id));
  }, []);

  const value = useMemo<UnreadValue>(
    () => ({
      friendsUnread,
      messagesUnread: unreadIds.length > 0,
      notificationsUnread,
      setActiveConversation,
      markConversationRead,
      setFriendsUnread,
      setNotificationsUnread,
    }),
    [friendsUnread, unreadIds, notificationsUnread, setActiveConversation, markConversationRead],
  );

  return <UnreadContext.Provider value={value}>{children}</UnreadContext.Provider>;
}

export function useSocialUnread() {
  return useContext(UnreadContext);
}
