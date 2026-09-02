import { Image } from "expo-image";
import { useEffect, useRef, useState } from "react";
import { Linking, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  fetchActiveAnnouncements,
  loadViewerPremium,
  markAnnouncementDismissed,
  markAnnouncementShown,
  pickAnnouncement,
  retainVisibleAnnouncement,
  type Announcement,
} from "@/lib/announcements";
import { useAuth } from "@/lib/auth";
import { publicAppUrl } from "@/lib/supabase";
import { colors } from "@/lib/theme";

export function AnnouncementHost() {
  const { session } = useAuth();
  const insets = useSafeAreaInsets();
  const signedIn = Boolean(session?.user);
  const token = session?.access_token ?? null;
  const [premium, setPremium] = useState<boolean | null>(null);
  const [item, setItem] = useState<Announcement | null>(null);
  const shownKey = useRef("");

  useEffect(() => {
    if (!item) {
      shownKey.current = "";
      return;
    }
    const key = `${item.id}:${item.revision}`;
    if (shownKey.current === key) return;
    shownKey.current = key;
    void markAnnouncementShown(item);
  }, [item]);

  useEffect(() => {
    let cancelled = false;
    if (!token) {
      setPremium(null);
      return;
    }
    void loadViewerPremium(token).then((value) => {
      if (!cancelled) setPremium(value);
    });
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    if (session === undefined) return;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | 0 = 0;

    async function load() {
      try {
        const items = await fetchActiveAnnouncements(token);
        if (cancelled) return;
        const viewer = { signedIn, premium: signedIn ? premium : null };
        const next = await pickAnnouncement(items, viewer);
        setItem((current) => retainVisibleAnnouncement(items, current, next, viewer));
      } catch {
        if (!cancelled) {
          if (retryTimer) clearTimeout(retryTimer);
          retryTimer = setTimeout(() => void load(), 8_000);
        }
      }
    }

    void load();
    const timer = setInterval(() => void load(), 15 * 60 * 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [session, signedIn, premium, token]);

  if (!item) return null;

  function dismiss() {
    if (!item || item.dismissible === false) return;
    void markAnnouncementDismissed(item);
    setItem(null);
  }

  function openCta() {
    if (!item?.ctaUrl) return;
    const href = item.ctaUrl.startsWith("/") ? `${publicAppUrl()}${item.ctaUrl}` : item.ctaUrl;
    void Linking.openURL(href);
  }

  const media = item.imageUrl ? (
    <Image source={{ uri: item.imageUrl }} style={item.placement === "banner" ? styles.bannerImage : styles.modalImage} />
  ) : null;
  const actions = (
    <View style={styles.actions}>
      {item.ctaUrl ? (
        <Pressable style={styles.primary} onPress={openCta}>
          <Text style={styles.primaryText}>{item.ctaLabel || "Learn more"}</Text>
        </Pressable>
      ) : null}
      {item.dismissible !== false ? (
        <Pressable style={styles.ghost} onPress={dismiss}>
          <Text style={styles.ghostText}>{item.placement === "banner" ? "×" : "Close"}</Text>
        </Pressable>
      ) : null}
    </View>
  );

  if (item.placement === "banner") {
    return (
      <View pointerEvents="box-none" style={[styles.bannerWrap, { paddingTop: insets.top }]}>
        <View style={styles.banner}>
          {media}
          <View style={styles.copy}>
            <Text style={styles.title}>{item.title}</Text>
            {item.body ? <Text style={styles.body}>{item.body}</Text> : null}
          </View>
          {actions}
        </View>
      </View>
    );
  }

  return (
    <Modal transparent animationType="fade" visible onRequestClose={dismiss}>
      <View style={styles.overlay}>
        <Pressable style={StyleSheet.absoluteFill} onPress={dismiss} />
        <View style={styles.modal}>
          {media}
          <View style={styles.modalBody}>
            <Text style={styles.modalTitle}>{item.title}</Text>
            {item.body ? <Text style={styles.body}>{item.body}</Text> : null}
            {actions}
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  bannerWrap: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 50,
  },
  banner: {
    marginHorizontal: 12,
    marginBottom: 8,
    padding: 12,
    borderRadius: 16,
    backgroundColor: colors.raised,
    borderWidth: 1,
    borderColor: colors.border,
    flexDirection: "row",
    gap: 10,
    alignItems: "center",
  },
  bannerImage: {
    width: 48,
    height: 48,
    borderRadius: 10,
  },
  copy: { flex: 1, minWidth: 0 },
  title: { color: colors.text, fontWeight: "700" },
  body: { color: colors.muted, marginTop: 4 },
  actions: { flexDirection: "row", gap: 8, alignItems: "center" },
  primary: {
    backgroundColor: colors.accent,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  primaryText: { color: colors.onAccent, fontWeight: "700" },
  ghost: { paddingHorizontal: 10, paddingVertical: 8 },
  ghostText: { color: colors.text, fontSize: 18 },
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.62)",
    justifyContent: "center",
    padding: 20,
  },
  modal: {
    backgroundColor: colors.raised,
    borderRadius: 20,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: colors.border,
  },
  modalImage: { width: "100%", height: 180 },
  modalBody: { padding: 20, gap: 10 },
  modalTitle: { color: colors.text, fontSize: 20, fontWeight: "700" },
});
