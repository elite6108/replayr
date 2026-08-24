import { create } from "zustand";
import { fetchFriendRequests, fetchNotifications } from "../services/api.friends";
import { fetchConversations } from "../services/api.messages";

function withUnread(unreadIds: string[]) {
  return { unreadIds, messagesUnread: unreadIds.length > 0 };
}

type SocialUnreadState = {
  friendsUnread: boolean;
  messagesUnread: boolean;
  notificationsUnread: number;
  unreadIds: string[];
  activeConversationId: string | null;
  refresh: (token: string) => Promise<void>;
  setFriendsUnread: (value: boolean) => void;
  setNotificationsUnread: (value: number) => void;
  setActiveConversation: (id: string | null) => void;
  markConversationRead: (id: string) => void;
  noteMessage: (conversationId: string, senderId: string, myId: string) => void;
  noteFriendRequest: () => void;
  noteNotification: () => void;
  reset: () => void;
};

export const useSocialUnreadStore = create<SocialUnreadState>((set, get) => ({
  friendsUnread: false,
  messagesUnread: false,
  notificationsUnread: 0,
  unreadIds: [],
  activeConversationId: null,
  refresh: async (token) => {
    const [conversations, requests, notifications] = await Promise.all([
      fetchConversations(token).catch(() => []),
      fetchFriendRequests(token).catch(() => ({ incoming: [], outgoing: [] })),
      fetchNotifications(token).catch(() => []),
    ]);
    set({
      friendsUnread: requests.incoming.length > 0,
      notificationsUnread: notifications.filter((item) => !item.readAt).length,
      ...withUnread(conversations.filter((item) => item.unreadCount > 0).map((item) => item.id)),
    });
  },
  setFriendsUnread: (friendsUnread) => set({ friendsUnread }),
  setNotificationsUnread: (notificationsUnread) => set({ notificationsUnread }),
  setActiveConversation: (activeConversationId) => set({ activeConversationId }),
  markConversationRead: (id) => set(withUnread(get().unreadIds.filter((item) => item !== id))),
  noteMessage: (conversationId, senderId, myId) => {
    if (!conversationId || senderId === myId) return;
    if (get().activeConversationId === conversationId) return;
    if (get().unreadIds.includes(conversationId)) {
      set({ messagesUnread: true });
      return;
    }
    set(withUnread([...get().unreadIds, conversationId]));
  },
  noteFriendRequest: () => set({ friendsUnread: true }),
  noteNotification: () => set({ notificationsUnread: get().notificationsUnread + 1 }),
  reset: () =>
    set({
      friendsUnread: false,
      messagesUnread: false,
      notificationsUnread: 0,
      unreadIds: [],
      activeConversationId: null,
    }),
}));
