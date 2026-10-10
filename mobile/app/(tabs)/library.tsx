import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Modal,
  Pressable,
  ScrollView,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { Image } from "expo-image";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { ClipThumb } from "@/components/ClipThumb";
import {
  FoldersLibraryPane,
  type FolderSort,
  type FoldersLibraryPaneHandle,
} from "@/components/folders/FoldersLibraryPane";
import { NotificationsSheet } from "@/components/NotificationsSheet";
import { Button } from "@/components/ui";
import { deleteCloudClip, fetchLibrary, type ManagedClip } from "@/lib/api";
import { seedClipFeed } from "@/lib/clipFeed";
import { ScreenshotLibraryGrid } from "@/components/ScreenshotLibraryGrid";
import { useAuth } from "@/lib/auth";
import { formatDurationMs, formatTimeAgo } from "@/lib/format";
import { useSocialUnread } from "@/lib/socialUnread";
import { colors } from "@/lib/theme";

const PAGE_SIZE = 24;
const GRID_GAP = 10;
type Filter = "all" | "public" | "unlisted" | "private";
type LibraryPane = "all" | "clips" | "screenshots" | "folders";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All visibility" },
  { id: "public", label: "Public" },
  { id: "unlisted", label: "Unlisted" },
  { id: "private", label: "Private" },
];

const MEDIA_CHIPS: { id: LibraryPane; label: string; icon?: keyof typeof Ionicons.glyphMap }[] = [
  { id: "all", label: "All" },
  { id: "clips", label: "Clips", icon: "play-circle-outline" },
  { id: "screenshots", label: "Screenshots", icon: "image-outline" },
  { id: "folders", label: "Folders", icon: "folder-open-outline" },
];

function libraryPaneParam(value: string | string[] | undefined): LibraryPane {
  const pane = Array.isArray(value) ? value[0] : value;
  return pane === "clips" || pane === "screenshots" || pane === "folders" ? pane : "all";
}

function sectionLabel(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Earlier";
  const now = new Date();
  const startOfWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay());
  if (date >= startOfWeek) return "This week";
  return date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

function visibilityLabel(value: ManagedClip["visibility"]) {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

export default function LibraryScreen() {
  const router = useRouter();
  const foldersPaneRef = useRef<FoldersLibraryPaneHandle>(null);
  const params = useLocalSearchParams<{ pane?: string | string[] }>();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { session } = useAuth();
  const { notificationsUnread } = useSocialUnread();
  const token = session?.access_token;
  const cardWidth = Math.floor((width - 32 - GRID_GAP) / 2);
  const [clips, setClips] = useState<ManagedClip[]>([]);
  const [total, setTotal] = useState(0);
  const [screenshotTotal, setScreenshotTotal] = useState(0);
  const [folderTotal, setFolderTotal] = useState(0);
  const [folderSort, setFolderSort] = useState<FolderSort>("updated");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [pane, setPane] = useState<LibraryPane>(() => libraryPaneParam(params.pane));
  const [filterOpen, setFilterOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);

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

  useEffect(() => {
    setPane(libraryPaneParam(params.pane));
  }, [params.pane]);

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
    for (const clip of visible.slice(1)) {
      const label = sectionLabel(clip.createdAt);
      const bucket = groups.get(label) ?? [];
      bucket.push(clip);
      groups.set(label, bucket);
    }
    return Array.from(groups, ([title, items], index) => ({
      title,
      count: items.length,
      newest: index === 0,
      data: chunk(items, 2),
    }));
  }, [visible]);

  const featured = visible[0] ?? null;
  const captureCount = pane === "screenshots" ? screenshotTotal : total;

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
      <View style={styles.brandBar}>
        <Image
          source={require("../../assets/images/replayr-logo.png")}
          style={styles.brandLogo}
          contentFit="contain"
          accessibilityLabel="Replayr"
        />
        <View style={styles.brandActions}>
          <Pressable
            style={({ pressed }) => [styles.roundButton, pressed && styles.roundButtonPressed]}
            onPress={() => {
              if (pane === "folders") {
                foldersPaneRef.current?.refresh();
                return;
              }
              void loadFirst();
            }}
            accessibilityRole="button"
            accessibilityLabel={pane === "folders" ? "Refresh folders" : "Refresh library"}
            hitSlop={8}
          >
            <Ionicons name="cloud-done-outline" size={19} color={colors.text} />
          </Pressable>
          <Pressable
            style={({ pressed }) => [styles.roundButton, pressed && styles.roundButtonPressed]}
            onPress={() => setNotificationsOpen(true)}
            accessibilityRole="button"
            accessibilityLabel="Notifications"
            hitSlop={8}
          >
            <Ionicons name="notifications-outline" size={20} color={colors.text} />
            {notificationsUnread > 0 ? <View style={styles.notificationPip} /> : null}
          </Pressable>
        </View>
      </View>

      <View style={styles.headingBlock}>
        <Text style={styles.eyebrow}>YOUR MEDIA</Text>
        <View style={styles.headingRow}>
          <View style={styles.headingCopy}>
            <Text style={styles.heading}>{pane === "folders" ? "Folders" : "Library"}</Text>
            {pane === "folders" ? (
              <Text style={styles.inlineCount}>
                {folderTotal} folder{folderTotal === 1 ? "" : "s"}
              </Text>
            ) : null}
          </View>
          {pane === "folders" ? (
            <Pressable
              style={({ pressed }) => [styles.newFolderButton, pressed && styles.roundButtonPressed]}
              onPress={() => foldersPaneRef.current?.openCreate()}
              accessibilityRole="button"
              accessibilityLabel="Create folder"
            >
              <Ionicons name="add" size={15} color={colors.onAccent} />
              <Text style={styles.newFolderText}>New</Text>
            </Pressable>
          ) : (
            <Text style={styles.captureCount}>
              {captureCount} capture{captureCount === 1 ? "" : "s"}
            </Text>
          )}
        </View>
      </View>

      <View style={styles.searchRow}>
        <View style={styles.searchBox}>
          <Ionicons name="search-outline" size={17} color={colors.muted} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder={pane === "folders" ? "Search folders" : "Search captures"}
            placeholderTextColor={colors.muted}
            style={styles.searchInput}
            returnKeyType="search"
            autoCapitalize="none"
            autoCorrect={false}
          />
          {query ? (
            <Pressable onPress={() => setQuery("")} hitSlop={8} accessibilityLabel="Clear search">
              <Ionicons name="close-circle" size={17} color={colors.muted} />
            </Pressable>
          ) : null}
        </View>
        <Pressable
          style={({ pressed }) => [
            styles.filterButton,
            (pane === "folders" ? folderSort !== "updated" : filter !== "all") && styles.filterButtonOn,
            pressed && styles.roundButtonPressed,
          ]}
          onPress={() => {
            if (pane === "folders") {
              foldersPaneRef.current?.openSort();
              return;
            }
            setFilterOpen(true);
          }}
          accessibilityRole="button"
          accessibilityLabel={pane === "folders" ? "Folder sorting" : "Library filters"}
        >
          <Ionicons
            name="options-outline"
            size={19}
            color={(pane === "folders" ? folderSort === "updated" : filter === "all") ? colors.text : colors.accent}
          />
        </Pressable>
      </View>

      <ScrollView
        style={styles.mediaChipScroller}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.mediaChips}
        keyboardShouldPersistTaps="handled"
      >
        {MEDIA_CHIPS.map((item) => {
          const active = item.id === pane;
          return (
            <Pressable
              key={item.id}
              style={[styles.mediaChip, active && styles.mediaChipOn]}
              onPress={() => {
                setPane(item.id);
                router.setParams({ pane: item.id });
                if (item.id === "all") setFilter("all");
                if (item.id === "screenshots" || item.id === "folders") {
                  setSelecting(false);
                  setSelectedIds([]);
                }
              }}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
            >
              {item.icon ? (
                <Ionicons name={item.icon} size={12} color={active ? colors.text : colors.muted} />
              ) : null}
              <Text style={[styles.mediaChipText, active && styles.mediaChipTextOn]}>{item.label}</Text>
            </Pressable>
          );
        })}
      </ScrollView>

      {selecting && pane !== "screenshots" && pane !== "folders" ? (
        <View style={styles.selectionBar}>
          <Text style={styles.selectionCount}>{selectedIds.length} selected</Text>
          <View style={styles.selectionActions}>
            <Pressable
              onPress={() => {
                setSelecting(false);
                setSelectedIds([]);
              }}
            >
              <Text style={styles.selectionCancel}>Cancel</Text>
            </Pressable>
            <Pressable onPress={confirmDeleteSelected} disabled={selectedIds.length === 0}>
              <Text style={[styles.selectionDelete, selectedIds.length === 0 && styles.disabled]}>Delete</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {pane === "folders" && token ? (
        <FoldersLibraryPane
          ref={foldersPaneRef}
          token={token}
          query={query}
          onTotalChange={setFolderTotal}
          onSortChange={setFolderSort}
        />
      ) : pane === "screenshots" && token ? (
        <ScreenshotLibraryGrid token={token} query={query} onTotalChange={setScreenshotTotal} />
      ) : (
        <>
      {error ? <Text style={styles.error}>{error}</Text> : null}

      <SectionList
        style={styles.listFlex}
        sections={sections}
        keyExtractor={(row, index) => row.map((clip) => clip.id).join("-") || String(index)}
        onEndReached={() => void loadMore()}
        onEndReachedThreshold={0.6}
        stickySectionHeadersEnabled={false}
        contentContainerStyle={styles.list}
        ListHeaderComponent={
          featured ? (
            <View style={styles.featureBlock}>
              <View style={styles.sectionHead}>
                <Text style={styles.sectionTitle}>Recently captured</Text>
                <Text style={styles.sectionMeta}>{formatTimeAgo(featured.createdAt) || "Recent"}</Text>
              </View>
              <Pressable style={styles.featureCard} onPress={() => openClip(featured)}>
                <ClipThumb
                  title={featured.title || "Clip"}
                  thumbnailUrl={featured.thumbnailUrl}
                  aspectRatio={16 / 8.2}
                  radius={12}
                />
                <View style={styles.featureShade} />
                {featured.status === "ready" ? (
                  <View style={styles.syncedBadge}>
                    <Ionicons name="cloud-done-outline" size={11} color={colors.text} />
                    <Text style={styles.syncedText}>Synced</Text>
                  </View>
                ) : null}
                <View style={styles.featureCopy}>
                  <Text style={styles.featureTitle} numberOfLines={1}>
                    {featured.title || "Untitled clip"}
                  </Text>
                  <Text style={styles.featureSub} numberOfLines={1}>
                    {visibilityLabel(featured.visibility)} · {formatTimeAgo(featured.createdAt)}
                  </Text>
                </View>
                <View style={styles.durationBadge}>
                  <Text style={styles.durationText}>{formatDurationMs(featured.durationMs)}</Text>
                </View>
                {selecting ? (
                  <View style={[styles.check, selectedIds.includes(featured.id) && styles.checkOn]}>
                    {selectedIds.includes(featured.id) ? <Ionicons name="checkmark" size={14} color="#000" /> : null}
                  </View>
                ) : null}
              </Pressable>
            </View>
          ) : null
        }
        ListEmptyComponent={
          featured ? null : loading ? (
            <Text style={styles.muted}>Loading cloud clips…</Text>
          ) : (
            <Text style={styles.muted}>
              {clips.length > 0 ? "No clips match those filters." : "Nothing in the cloud yet. Capture from the Windows app."}
            </Text>
          )
        }
        ListFooterComponent={loadingMore ? <Text style={styles.footer}>Loading more…</Text> : null}
        renderSectionHeader={({ section }) => (
          <View style={styles.sectionHead}>
            <View style={styles.sectionTitleRow}>
              <Text style={styles.sectionTitle}>{section.title}</Text>
              <Text style={styles.sectionCount}>
                {section.count} clip{section.count === 1 ? "" : "s"}
              </Text>
            </View>
            {section.newest ? <Text style={styles.newest}>Newest first</Text> : null}
          </View>
        )}
        renderItem={({ item: row }) => (
          <View style={styles.grid}>
            {row.map((clip) => (
              <Pressable key={clip.id} onPress={() => openClip(clip)} style={[styles.clipCard, { width: cardWidth }]}>
                <View style={styles.cardThumb}>
                  <ClipThumb
                    title={clip.title || "Clip"}
                    thumbnailUrl={clip.thumbnailUrl}
                    aspectRatio={1.18}
                    radius={10}
                  />
                  <View style={styles.cardDuration}>
                    <Text style={styles.durationText}>{formatDurationMs(clip.durationMs)}</Text>
                  </View>
                  {selecting ? (
                    <View style={[styles.check, selectedIds.includes(clip.id) && styles.checkOn]}>
                      {selectedIds.includes(clip.id) ? <Ionicons name="checkmark" size={14} color="#000" /> : null}
                    </View>
                  ) : (
                    <View style={styles.cardStatus}>
                      <Ionicons
                        name={clip.status === "ready" ? "cloud-done-outline" : "time-outline"}
                        size={11}
                        color={colors.muted}
                      />
                    </View>
                  )}
                </View>
                <View style={styles.cardCopy}>
                  <Text style={styles.cardTitle} numberOfLines={1}>
                    {clip.title || "Untitled clip"}
                  </Text>
                  <Text style={styles.cardMeta} numberOfLines={1}>
                    {visibilityLabel(clip.visibility)} · {formatTimeAgo(clip.createdAt)}
                  </Text>
                </View>
              </Pressable>
            ))}
          </View>
        )}
      />
        </>
      )}

      <NotificationsSheet visible={notificationsOpen} token={token} onClose={() => setNotificationsOpen(false)} />

      <Modal visible={filterOpen} transparent animationType="slide" onRequestClose={() => setFilterOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setFilterOpen(false)} />
        <View style={[styles.filterSheet, { paddingBottom: Math.max(insets.bottom, 16) }]}>
          <View style={styles.sheetHead}>
            <View>
              <Text style={styles.sheetTitle}>Library filters</Text>
              <Text style={styles.sheetSub}>Choose which cloud clips are shown.</Text>
            </View>
            <Pressable onPress={() => setFilterOpen(false)} hitSlop={8} accessibilityLabel="Close filters">
              <Ionicons name="close" size={22} color={colors.text} />
            </Pressable>
          </View>
          <View style={styles.filterChoices}>
            {FILTERS.map((item) => (
              <Pressable
                key={item.id}
                style={[styles.filterChoice, filter === item.id && styles.filterChoiceOn]}
                onPress={() => {
                  setFilter(item.id);
                  setPane("clips");
                  setFilterOpen(false);
                }}
              >
                <Text style={[styles.filterChoiceText, filter === item.id && styles.filterChoiceTextOn]}>{item.label}</Text>
                {filter === item.id ? <Ionicons name="checkmark" size={17} color={colors.accent} /> : null}
              </Pressable>
            ))}
          </View>
          <Pressable
            style={styles.selectAction}
            onPress={() => {
              setFilterOpen(false);
              setPane("clips");
              setSelecting(true);
              setSelectedIds([]);
            }}
          >
            <Ionicons name="checkmark-circle-outline" size={19} color={colors.text} />
            <Text style={styles.selectActionText}>Select clips</Text>
          </Pressable>
        </View>
      </Modal>
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
  page: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, backgroundColor: colors.bg, padding: 24, gap: 12, justifyContent: "center" },
  hero: { color: colors.text, fontSize: 28, fontWeight: "700" },
  muted: { color: colors.muted, fontSize: 14, lineHeight: 20, paddingHorizontal: 16 },
  brandBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 2,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.accentRing,
  },
  brandLogo: { width: 126, height: 36 },
  brandActions: { flexDirection: "row", alignItems: "center", gap: 9 },
  roundButton: {
    position: "relative",
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.chrome,
    alignItems: "center",
    justifyContent: "center",
  },
  roundButtonPressed: { borderColor: colors.accentRing, backgroundColor: colors.raised },
  notificationPip: {
    position: "absolute",
    top: 6,
    right: 6,
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: colors.accent,
  },
  headingBlock: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 10 },
  eyebrow: { color: colors.muted, fontSize: 9, fontWeight: "700", letterSpacing: 1.4 },
  headingRow: { flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between" },
  headingCopy: { flexDirection: "row", alignItems: "baseline", gap: 9, flexShrink: 1 },
  heading: { color: colors.text, fontSize: 26, lineHeight: 31, fontWeight: "800", letterSpacing: -0.5 },
  inlineCount: { color: colors.muted, fontSize: 11 },
  captureCount: { color: colors.muted, fontSize: 11, paddingBottom: 4 },
  newFolderButton: {
    height: 28,
    borderRadius: 14,
    paddingHorizontal: 11,
    marginBottom: 2,
    backgroundColor: colors.accent,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  newFolderText: { color: colors.onAccent, fontSize: 11, fontWeight: "800" },
  searchRow: { flexDirection: "row", alignItems: "center", gap: 9, paddingHorizontal: 16 },
  searchBox: {
    flex: 1,
    minHeight: 42,
    borderRadius: 21,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.chrome,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 13,
  },
  searchInput: { flex: 1, color: colors.text, fontSize: 13, paddingVertical: 9 },
  filterButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.chrome,
    alignItems: "center",
    justifyContent: "center",
  },
  filterButtonOn: { borderColor: colors.accentRing, backgroundColor: colors.accentDim },
  mediaChipScroller: {
    flexGrow: 0,
    flexShrink: 0,
    height: 50,
  },
  mediaChips: {
    alignItems: "center",
    gap: 7,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 12,
  },
  mediaChip: {
    height: 28,
    paddingHorizontal: 11,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.chrome,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
  },
  mediaChipOn: { backgroundColor: colors.raised, borderColor: colors.raised },
  mediaChipText: { color: colors.muted, fontSize: 11, fontWeight: "600" },
  mediaChipTextOn: { color: colors.text },
  selectionBar: {
    marginHorizontal: 16,
    marginBottom: 10,
    paddingHorizontal: 12,
    minHeight: 38,
    borderRadius: 10,
    backgroundColor: colors.raised,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  selectionCount: { color: colors.text, fontSize: 12, fontWeight: "700" },
  selectionActions: { flexDirection: "row", alignItems: "center", gap: 16 },
  selectionCancel: { color: colors.muted, fontSize: 12, fontWeight: "600" },
  selectionDelete: { color: colors.danger, fontSize: 12, fontWeight: "700" },
  disabled: { color: colors.muted },
  error: { color: colors.danger, paddingHorizontal: 16, marginBottom: 8 },
  listFlex: { flex: 1 },
  list: { paddingBottom: 112 },
  featureBlock: { paddingHorizontal: 16, marginBottom: 14, gap: 7 },
  sectionHead: {
    minHeight: 28,
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  sectionTitleRow: { flexDirection: "row", alignItems: "baseline", gap: 6 },
  sectionTitle: { color: colors.text, fontSize: 14, fontWeight: "800" },
  sectionMeta: { color: colors.muted, fontSize: 10 },
  sectionCount: { color: colors.muted, fontSize: 9 },
  newest: { color: colors.accent, fontSize: 9, fontWeight: "700" },
  featureCard: { position: "relative", overflow: "hidden", borderRadius: 12, backgroundColor: colors.raised },
  featureShade: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: "44%",
    backgroundColor: "rgba(3, 7, 11, 0.68)",
  },
  syncedBadge: {
    position: "absolute",
    top: 8,
    right: 8,
    height: 22,
    borderRadius: 11,
    paddingHorizontal: 8,
    backgroundColor: "rgba(5, 10, 16, 0.78)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.accentRing,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  syncedText: { color: colors.text, fontSize: 9, fontWeight: "700" },
  featureCopy: { position: "absolute", left: 10, right: 52, bottom: 9, gap: 2 },
  featureTitle: { color: colors.text, fontSize: 13, fontWeight: "800" },
  featureSub: { color: "#b7c0cc", fontSize: 9 },
  durationBadge: {
    position: "absolute",
    right: 8,
    bottom: 8,
    paddingHorizontal: 6,
    height: 19,
    borderRadius: 6,
    backgroundColor: "rgba(3, 7, 11, 0.78)",
    alignItems: "center",
    justifyContent: "center",
  },
  durationText: { color: colors.text, fontSize: 9, fontWeight: "700", fontVariant: ["tabular-nums"] },
  grid: { flexDirection: "row", gap: GRID_GAP, marginBottom: GRID_GAP, paddingHorizontal: 16 },
  clipCard: {
    overflow: "hidden",
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.raised,
  },
  cardThumb: { position: "relative" },
  cardDuration: {
    position: "absolute",
    left: 6,
    bottom: 6,
    paddingHorizontal: 5,
    height: 18,
    borderRadius: 5,
    backgroundColor: "rgba(3, 7, 11, 0.76)",
    alignItems: "center",
    justifyContent: "center",
  },
  cardStatus: {
    position: "absolute",
    top: 6,
    right: 6,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: "rgba(3, 7, 11, 0.72)",
    alignItems: "center",
    justifyContent: "center",
  },
  cardCopy: { paddingHorizontal: 8, paddingTop: 7, paddingBottom: 9, gap: 3 },
  cardTitle: { color: colors.text, fontSize: 11, fontWeight: "700" },
  cardMeta: { color: colors.muted, fontSize: 9 },
  check: {
    position: "absolute",
    top: 6,
    right: 6,
    width: 21,
    height: 21,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: "#fff",
    backgroundColor: "rgba(3, 7, 11, 0.5)",
    alignItems: "center",
    justifyContent: "center",
  },
  checkOn: { backgroundColor: "#fff", borderColor: "#fff" },
  footer: { color: colors.muted, textAlign: "center", paddingVertical: 16 },
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: "rgba(0, 0, 0, 0.58)" },
  filterSheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    padding: 16,
    gap: 14,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    backgroundColor: colors.card,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  sheetHead: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between" },
  sheetTitle: { color: colors.text, fontSize: 18, fontWeight: "800" },
  sheetSub: { color: colors.muted, fontSize: 12, marginTop: 3 },
  filterChoices: { gap: 7 },
  filterChoice: {
    minHeight: 42,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.chrome,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  filterChoiceOn: { borderColor: colors.accentRing, backgroundColor: colors.accentDim },
  filterChoiceText: { color: colors.muted, fontSize: 13, fontWeight: "600" },
  filterChoiceTextOn: { color: colors.text },
  selectAction: {
    minHeight: 44,
    borderRadius: 11,
    backgroundColor: colors.raised,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  selectActionText: { color: colors.text, fontSize: 13, fontWeight: "700" },
});
