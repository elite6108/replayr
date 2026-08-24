import { create } from "zustand";
import { fetchFriendRequests } from "../services/api.friends";
import { fetchConversations } from "../services/api.messages";

function withUnread(unreadIds: string[]) {
  return { unreadIds, messagesUnread: unreadIds.length > 0 };
}

type SocialUnreadState = {
  friendsUnread: boolean;
  messagesUnread: boolean;
  unreadIds: string[];
  activeConversationId: string | null;
  refresh: (token: string) => Promise<void>;
  setFriendsUnread: (value: boolean) => void;
  setActiveConversation: (id: string | null) => void;
  markConversationRead: (id: string) => void;
  noteMessage: (conversationId: string, senderId: string, myId: string) => void;
  noteFriendRequest: () => void;
  reset: () => void;
};

export const useSocialUnreadStore = create<SocialUnreadState>((set, get) => ({
  friendsUnread: false,
  messagesUnread: false,
  unreadIds: [],
  activeConversationId: null,
  refresh: async (token) => {
    const [conversations, requests] = await Promise.all([
      fetchConversations(token).catch(() => []),
      fetchFriendRequests(token).catch(() => ({ incoming: [], outgoing: [] })),
    ]);
    set({
      friendsUnread: requests.incoming.length > 0,
      ...withUnread(conversations.filter((item) => item.unreadCount > 0).map((item) => item.id)),
    });
  },
  setFriendsUnread: (friendsUnread) => set({ friendsUnread }),
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
  reset: () => set({ friendsUnread: false, messagesUnread: false, unreadIds: [], activeConversationId: null }),
}));
