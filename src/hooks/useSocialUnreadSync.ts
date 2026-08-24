import { useEffect } from "react";
import { getSupabase, supabaseConfigured } from "../services/supabase";
import { useAuthStore } from "../stores/authStore";
import { useSocialUnreadStore } from "../stores/socialUnreadStore";

export function useSocialUnreadSync() {
  const token = useAuthStore((state) => state.session?.access_token);
  const userId = useAuthStore((state) => state.user?.id);
  const refresh = useSocialUnreadStore((state) => state.refresh);
  const reset = useSocialUnreadStore((state) => state.reset);
  const noteMessage = useSocialUnreadStore((state) => state.noteMessage);
  const noteFriendRequest = useSocialUnreadStore((state) => state.noteFriendRequest);
  const noteNotification = useSocialUnreadStore((state) => state.noteNotification);

  useEffect(() => {
    if (!token || !userId || !supabaseConfigured()) {
      reset();
      return;
    }
    void refresh(token);
    const supabase = getSupabase();
    const channel = supabase
      .channel(`social-unread:${userId}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" }, (payload) => {
        const row = payload.new as { conversation_id?: string; sender_id?: string };
        if (row.conversation_id && row.sender_id) noteMessage(row.conversation_id, row.sender_id, userId);
      })
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications" }, (payload) => {
        const row = payload.new as { kind?: string; conversation_id?: string | null; actor_id?: string | null };
        if (row.kind === "friend_request") noteFriendRequest();
        if (
          (row.kind === "friend_request" ||
            row.kind === "friend_accept" ||
            row.kind === "message" ||
            row.kind === "group_invite" ||
            row.kind === "clip_like" ||
            row.kind === "clip_comment") &&
          row.actor_id !== userId
        ) {
          noteNotification();
        }
        if ((row.kind === "message" || row.kind === "group_invite") && row.conversation_id) {
          noteMessage(row.conversation_id, row.actor_id || "", userId);
        }
      })
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [token, userId, refresh, reset, noteMessage, noteFriendRequest, noteNotification]);
}
