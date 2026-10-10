import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, SectionList, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { useRouter } from "expo-router";
import { ClipThumb } from "@/components/ClipThumb";
import { fetchScreenshots, type CloudScreenshot } from "@/lib/api";
import { screenshotImageUrl } from "@/lib/supabase";
import { formatSectionLabel, formatTimeAgo } from "@/lib/format";
import { colors } from "@/lib/theme";

const PAGE_SIZE = 24;
const GAP = 10;

export function ScreenshotLibraryGrid({
  token,
  query = "",
  onTotalChange,
}: {
  token: string;
  query?: string;
  onTotalChange?: (total: number) => void;
}) {
  const router = useRouter();
  const { width } = useWindowDimensions();
  const cardWidth = Math.floor((width - 32 - GAP) / 2);
  const [shots, setShots] = useState<CloudScreenshot[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  const loadFirst = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const page = await fetchScreenshots(token, { page: 1, limit: PAGE_SIZE });
      setShots(page.screenshots);
      setTotal(page.total);
      onTotalChange?.(page.total);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load screenshots.");
    } finally {
      setLoading(false);
    }
  }, [onTotalChange, token]);

  useEffect(() => {
    void loadFirst();
  }, [loadFirst]);

  async function loadMore() {
    if (loading || loadingMore || shots.length >= total) return;
    setLoadingMore(true);
    try {
      const nextPage = Math.floor(shots.length / PAGE_SIZE) + 1;
      const page = await fetchScreenshots(token, { page: nextPage, limit: PAGE_SIZE });
      setTotal(page.total);
      setShots((current) => {
        const seen = new Set(current.map((shot) => shot.id));
        return [...current, ...page.screenshots.filter((shot) => !seen.has(shot.id))];
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load more screenshots.");
    } finally {
      setLoadingMore(false);
    }
  }

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return shots;
    return shots.filter((shot) => `${shot.slug} ${shot.width}x${shot.height}`.toLowerCase().includes(needle));
  }, [query, shots]);

  const sections = chunk(visible, 2).map((row, index) => ({
    title: index === 0 && visible[0] ? formatSectionLabel(visible[0].createdAt) : "",
    data: [row],
  }));

  return (
    <>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <SectionList
        style={styles.listFlex}
        sections={sections}
        keyExtractor={(row, index) => row.map((shot) => shot.id).join("-") || String(index)}
        onEndReached={() => void loadMore()}
        onEndReachedThreshold={0.6}
        stickySectionHeadersEnabled={false}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          loading ? (
            <Text style={styles.muted}>Loading screenshots…</Text>
          ) : (
            <Text style={styles.muted}>
              {shots.length > 0 ? "No screenshots match that search." : "No cloud screenshots yet. Capture from the Windows app while signed in."}
            </Text>
          )
        }
        ListFooterComponent={loadingMore ? <Text style={styles.footer}>Loading more…</Text> : null}
        renderSectionHeader={({ section }) =>
          section.title ? (
            <View style={styles.sectionHead}>
              <Text style={styles.sectionTitle}>{section.title}</Text>
              <Text style={styles.sectionCount}>{visible.length} captures</Text>
            </View>
          ) : null
        }
        renderItem={({ item: row }) => (
          <View style={styles.grid}>
            {row.map((shot) => (
              <Pressable
                key={shot.id}
                onPress={() => router.push({ pathname: "/s/[slug]", params: { slug: shot.slug } })}
                style={[styles.card, { width: cardWidth }]}
              >
                <ClipThumb
                  title={`${shot.width}×${shot.height}`}
                  thumbnailUrl={screenshotImageUrl(shot.slug)}
                  aspectRatio={1.18}
                  radius={10}
                />
                <View style={styles.cardCopy}>
                  <Text style={styles.cardTitle}>Screenshot</Text>
                  <Text style={styles.cardMeta}>
                    {shot.width}×{shot.height} · {formatTimeAgo(shot.createdAt)}
                  </Text>
                </View>
              </Pressable>
            ))}
          </View>
        )}
      />
    </>
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
  muted: { color: colors.muted, fontSize: 14, lineHeight: 20, paddingHorizontal: 16 },
  error: { color: colors.danger, paddingHorizontal: 16, marginBottom: 8 },
  listFlex: { flex: 1 },
  list: { paddingBottom: 112 },
  sectionHead: {
    minHeight: 30,
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  sectionTitle: { color: colors.text, fontSize: 14, fontWeight: "800" },
  sectionCount: { color: colors.muted, fontSize: 9 },
  grid: { flexDirection: "row", gap: GAP, marginBottom: GAP, paddingHorizontal: 16 },
  card: {
    overflow: "hidden",
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.raised,
  },
  cardCopy: { paddingHorizontal: 8, paddingTop: 7, paddingBottom: 9, gap: 3 },
  cardTitle: { color: colors.text, fontSize: 11, fontWeight: "700" },
  cardMeta: { color: colors.muted, fontSize: 9 },
  footer: { color: colors.muted, textAlign: "center", paddingVertical: 16 },
});
