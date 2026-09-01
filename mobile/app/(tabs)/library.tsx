import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Pressable,
  ScrollView,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { ClipThumb } from "@/components/ClipThumb";
import { Button } from "@/components/ui";
import { deleteCloudClip, fetchLibrary, type ManagedClip } from "@/lib/api";
import { foldersHref } from "@/lib/api.folders";
import { seedClipFeed } from "@/lib/clipFeed";
import { useAuth } from "@/lib/auth";
import { formatSectionLabel } from "@/lib/format";
import { colors } from "@/lib/theme";

const PAGE_SIZE = 24;
const GAP = 3;
type Filter = "all" | "public" | "unlisted" | "private";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All Clips" },
  { id: "public", label: "Public" },
  { id: "unlisted", label: "Unlisted" },
  { id: "private", label: "Private" },
];

export default function LibraryScreen() {
  const router = useRouter();
  const { width } = useWindowDimensions();
  const { session } = useAuth();
  const token = session?.access_token;
  const cell = Math.floor((width - GAP * 2) / 3);
  const [clips, setClips] = useState<ManagedClip[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const loadFirst = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const page = await fetchLibrary(token, { page: 1, limit: PAGE_SIZE });
      setClips(page.clips);
      setTotal(page.total);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load cloud clips.");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (!session) {
      setLoading(false);
      return;
    }
    void loadFirst();
  }, [session, loadFirst]);

  async function loadMore() {
    if (!token || loading || loadingMore || clips.length >= total) return;
    setLoadingMore(true);
    try {
      const nextPage = Math.floor(clips.length / PAGE_SIZE) + 1;
      const page = await fetchLibrary(token, { page: nextPage, limit: PAGE_SIZE });
      setTotal(page.total);
      setClips((current) => {
        const seen = new Set(current.map((clip) => clip.id));
        return [...current, ...page.clips.filter((clip) => !seen.has(clip.id))];
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load more clips.");
    } finally {
      setLoadingMore(false);
    }
  }

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return clips.filter((clip) => {
      if (filter !== "all" && clip.visibility !== filter) return false;
      if (needle && !(clip.title || "").toLowerCase().includes(needle) && !clip.slug.includes(needle)) return false;
      return true;
    });
  }, [clips, filter, query]);

  const sections = useMemo(() => {
    const groups = new Map<string, ManagedClip[]>();
    for (const clip of visible) {
      const label = formatSectionLabel(clip.createdAt);
      const bucket = groups.get(label) ?? [];
      bucket.push(clip);
      groups.set(label, bucket);
    }
    return Array.from(groups, ([title, items]) => ({ title, data: chunk(items, 3) }));
  }, [visible]);

  const album = visible.find((clip) => clip.thumbnailUrl) ?? visible[0] ?? null;

  function openClip(clip: ManagedClip) {
    if (selecting) {
      setSelectedIds((current) =>
        current.includes(clip.id) ? current.filter((id) => id !== clip.id) : [...current, clip.id],
      );
      return;
    }
    if (clip.status !== "ready") return;
    const ready = visible.filter((item) => item.status === "ready");
    seedClipFeed({
      source: "library",
      items: ready.map((item) => ({ slug: item.slug, clipId: item.id })),
      startSlug: clip.slug,
      page: Math.max(1, Math.ceil(clips.length / PAGE_SIZE)),
      hasMore: clips.length < total,
      libraryFilter: { visibility: filter, query },
    });
    router.push({ pathname: "/c/[slug]", params: { slug: clip.slug, clipId: clip.id } });
  }

  function confirmDeleteSelected() {
    const chosen = clips.filter((clip) => selectedIds.includes(clip.id));
    if (chosen.length === 0) return;
    Alert.alert("Delete clips?", `Remove ${chosen.length} clip${chosen.length === 1 ? "" : "s"} from the cloud.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          void (async () => {
            if (!token) return;
            for (const clip of chosen) {
              try {
                await deleteCloudClip(clip.id, token);
              } catch {
                /* keep going */
              }
            }
            const gone = new Set(chosen.map((clip) => clip.id));
            setClips((current) => current.filter((clip) => !gone.has(clip.id)));
            setTotal((current) => Math.max(0, current - chosen.length));
            setSelectedIds([]);
            setSelecting(false);
          })();
        },
      },
    ]);
  }

  if (session === undefined) {
    return (
      <View style={styles.center}>
        <Text style={styles.muted}>Loading…</Text>
      </View>
    );
  }

  if (!session) {
    return (
      <View style={styles.center}>
        <Text style={styles.hero}>Library</Text>
        <Text style={styles.muted}>Sign in with the same Replayr account as the Windows app.</Text>
        <Button label="Sign in" kind="primary" onPress={() => router.push("/signin")} />
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.page} edges={["top"]}>
      <View style={styles.topBar}>
        <Pressable
          onPress={() => {
            setSelecting((current) => !current);
            setSelectedIds([]);
          }}
        >
          <Text style={styles.topAction}>{selecting ? "Cancel" : "Select"}</Text>
        </Pressable>
        <Text style={styles.topTitle}>Library</Text>
        {selecting ? (
          <Pressable onPress={confirmDeleteSelected} disabled={selectedIds.length === 0}>
            <Text style={[styles.topAction, selectedIds.length === 0 && styles.disabled]}>Delete</Text>
          </Pressable>
        ) : (
          <Pressable
            onPress={() =>
              Alert.alert("Capture is on Windows", "The phone app watches and shares cloud clips. Record from the Replayr desktop app.")
            }
          >
            <Ionicons name="add" size={28} color={colors.text} />
          </Pressable>
        )}
      </View>
      <View style={styles.libraryTabs}>
        <Text style={[styles.libraryTab, styles.libraryTabOn]}>Clips</Text>
        <Pressable onPress={() => router.push(foldersHref())}>
          <Text style={styles.libraryTab}>Folders</Text>
        </Pressable>
      </View>

      <View style={styles.filterRow}>
        <Pressable style={styles.iconBtn} onPress={() => setSearchOpen((current) => !current)}>
          <Ionicons name="search" size={18} color={colors.text} />
        </Pressable>
        <Pressable
          style={styles.filterBtn}
          onPress={() =>
            Alert.alert("Filters", "Choose a visibility chip. Unlisted links never include your username.", [
              { text: "OK" },
            ])
          }
        >
          <Ionicons name="options-outline" size={16} color={colors.text} />
          <Text style={styles.filterLabel}>Filters</Text>
        </Pressable>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
          {FILTERS.map((item) => (
            <Pressable
              key={item.id}
              onPress={() => setFilter(item.id)}
              style={[styles.chip, filter === item.id && styles.chipOn]}
            >
              <Text style={[styles.chipText, filter === item.id && styles.chipTextOn]}>{item.label}</Text>
            </Pressable>
          ))}
        </ScrollView>
      </View>
      {searchOpen ? (
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search clips"
          placeholderTextColor={colors.muted}
          style={styles.search}
          autoFocus
        />
      ) : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}

      <SectionList
        sections={sections}
        keyExtractor={(row, index) => row.map((clip) => clip.id).join("-") || String(index)}
        onEndReached={() => void loadMore()}
        onEndReachedThreshold={0.6}
        stickySectionHeadersEnabled={false}
        contentContainerStyle={styles.list}
        ListHeaderComponent={
          album ? (
            <View style={styles.albumBlock}>
              <View style={styles.sectionHead}>
                <Text style={styles.sectionTitle}>My Albums</Text>
                <Ionicons name="chevron-forward" size={18} color={colors.muted} />
              </View>
              <Pressable onPress={() => openClip(album)}>
                <ClipThumb title={album.title || "Cloud"} thumbnailUrl={album.thumbnailUrl} wide />
                <Text style={styles.albumCaption}>Cloud · {visible.length} clips</Text>
              </Pressable>
            </View>
          ) : null
        }
        ListEmptyComponent={
          loading ? (
            <Text style={styles.muted}>Loading cloud clips…</Text>
          ) : (
            <Text style={styles.muted}>Nothing in the cloud yet. Capture from the Windows app.</Text>
          )
        }
        ListFooterComponent={loadingMore ? <Text style={styles.footer}>Loading more…</Text> : null}
        renderSectionHeader={({ section }) => (
          <Text style={styles.sectionTitle}>{section.title}</Text>
        )}
        renderItem={({ item: row }) => (
          <View style={styles.grid}>
            {row.map((clip) => (
              <Pressable key={clip.id} onPress={() => openClip(clip)} style={[styles.cell, { width: cell, height: cell }]}>
                <ClipThumb title={clip.title || "Clip"} thumbnailUrl={clip.thumbnailUrl} square />
                {selecting ? (
                  <View style={[styles.check, selectedIds.includes(clip.id) && styles.checkOn]}>
                    {selectedIds.includes(clip.id) ? <Ionicons name="checkmark" size={16} color="#000" /> : null}
                  </View>
                ) : null}
              </Pressable>
            ))}
          </View>
        )}
      />
    </SafeAreaView>
  );
}

function chunk<T>(items: T[], size: number) {
  const rows: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    rows.push(items.slice(index, index + size));
  }
  return rows;
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: "#000" },
  center: { flex: 1, backgroundColor: "#000", padding: 24, gap: 12, justifyContent: "center" },
  hero: { color: colors.text, fontSize: 28, fontWeight: "700" },
  muted: { color: colors.muted, fontSize: 14, lineHeight: 20, paddingHorizontal: 16 },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 10,
  },
  topAction: { color: colors.text, fontSize: 16, width: 64 },
  topTitle: { color: colors.text, fontSize: 17, fontWeight: "700" },
  libraryTabs: { flexDirection: "row", gap: 16, paddingHorizontal: 16, paddingBottom: 10 },
  libraryTab: { color: colors.muted, fontSize: 16, fontWeight: "600", paddingBottom: 6 },
  libraryTabOn: { color: colors.text, borderBottomWidth: 2, borderBottomColor: colors.accent },
  disabled: { color: colors.muted },
  filterRow: { flexDirection: "row", alignItems: "center", paddingLeft: 12, gap: 8, marginBottom: 8 },
  iconBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: "#1c1c1e",
    alignItems: "center",
    justifyContent: "center",
  },
  filterBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#1c1c1e",
    borderRadius: 17,
    paddingHorizontal: 12,
    height: 34,
  },
  filterLabel: { color: colors.text, fontSize: 14, fontWeight: "600" },
  chips: { gap: 8, paddingRight: 16, alignItems: "center" },
  chip: { backgroundColor: "#1c1c1e", borderRadius: 17, paddingHorizontal: 14, height: 34, justifyContent: "center" },
  chipOn: { backgroundColor: "#3a3a3c" },
  chipText: { color: colors.text, fontSize: 14 },
  chipTextOn: { fontWeight: "700" },
  search: {
    marginHorizontal: 12,
    marginBottom: 8,
    backgroundColor: "#1c1c1e",
    color: colors.text,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  error: { color: colors.danger, paddingHorizontal: 16, marginBottom: 8 },
  list: { paddingBottom: 28 },
  albumBlock: { paddingHorizontal: 12, marginBottom: 18, gap: 8 },
  albumCaption: { color: colors.muted, marginTop: 8, fontSize: 13 },
  sectionHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  sectionTitle: { color: colors.text, fontSize: 22, fontWeight: "800", paddingHorizontal: 12, marginBottom: 10, marginTop: 8 },
  grid: { flexDirection: "row", gap: GAP, marginBottom: GAP },
  cell: { overflow: "hidden", backgroundColor: "#111" },
  check: {
    position: "absolute",
    top: 8,
    right: 8,
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: "#fff",
    backgroundColor: "transparent",
    alignItems: "center",
    justifyContent: "center",
  },
  checkOn: { backgroundColor: "#fff", borderColor: "#fff" },
  footer: { color: colors.muted, textAlign: "center", paddingVertical: 16 },
});
