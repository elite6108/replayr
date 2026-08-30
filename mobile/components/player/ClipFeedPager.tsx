import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FlatList,
  StyleSheet,
  useWindowDimensions,
  View,
  type ViewToken,
} from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { fetchBillingStatus } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { beginFeedPlayback, stopFeedPlayers } from "@/lib/feedPlayers";
import {
  ensureClipFeed,
  loadMoreClipFeed,
  prefetchPlayback,
  removeClipFromFeed,
  retainPlayback,
  useClipFeed,
} from "@/lib/clipFeed";
import { ClipPlayerCell } from "./ClipPlayerCell";

const VIEWABILITY = { itemVisiblePercentThreshold: 80 };

export function ClipFeedPager({ slug, clipId }: { slug: string; clipId?: string }) {
  const router = useRouter();
  const { height } = useWindowDimensions();
  const { session } = useAuth();
  const token = session?.access_token;
  const feed = useClipFeed();
  const listRef = useRef<FlatList>(null);
  const [focused, setFocused] = useState(0);
  const [showAd, setShowAd] = useState(true);

  useEffect(() => {
    ensureClipFeed(slug, clipId);
  }, [slug, clipId]);

  useFocusEffect(
    useCallback(() => {
      beginFeedPlayback();
      return () => {
        stopFeedPlayers();
      };
    }, []),
  );

  function goBack() {
    stopFeedPlayers();
    router.back();
  }

  const items = feed?.items ?? [{ slug, clipId }];
  const startIndex = useMemo(() => {
    const index = items.findIndex((item) => item.slug === slug);
    return index >= 0 ? index : 0;
  }, [items, slug]);

  useEffect(() => {
    setFocused(startIndex);
    if (startIndex > 0) {
      requestAnimationFrame(() => {
        try {
          listRef.current?.scrollToIndex({ index: startIndex, animated: false });
        } catch {
          /* layout not ready */
        }
      });
    }
  }, [startIndex]);

  useEffect(() => {
    if (!token) {
      setShowAd(true);
      return;
    }
    let cancelled = false;
    void fetchBillingStatus(token)
      .then((status) => {
        if (!cancelled) setShowAd(status.ads);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    const nearby = [-1, 0, 1]
      .map((offset) => items[focused + offset]?.slug)
      .filter((value): value is string => Boolean(value));
    for (const next of nearby) prefetchPlayback(next, token);
    retainPlayback(nearby);
  }, [focused, items, token]);

  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    const next = viewableItems.find((entry) => entry.isViewable)?.index;
    if (typeof next === "number") setFocused(next);
  }).current;

  function onDeleted(deletedSlug: string) {
    const remaining = items.filter((item) => item.slug !== deletedSlug);
    removeClipFromFeed(deletedSlug);
    if (remaining.length === 0) {
      goBack();
    }
  }

  return (
    <View style={styles.stage}>
      <FlatList
        ref={listRef}
        data={items}
        keyExtractor={(item) => item.slug}
        pagingEnabled
        showsVerticalScrollIndicator={false}
        snapToInterval={height}
        snapToAlignment="start"
        decelerationRate="fast"
        disableIntervalMomentum
        getItemLayout={(_, index) => ({ length: height, offset: height * index, index })}
        initialScrollIndex={startIndex}
        onViewableItemsChanged={onViewableItemsChanged}
        viewabilityConfig={VIEWABILITY}
        onEndReached={() => void loadMoreClipFeed(token)}
        onEndReachedThreshold={0.4}
        extraData={focused}
        renderItem={({ item, index }) => (
          <ClipPlayerCell
            item={item}
            active={index === focused}
            nearby={Math.abs(index - focused) <= 1}
            height={height}
            token={token}
            userId={session?.user.id}
            showAd={showAd}
            onBack={goBack}
            onDeleted={onDeleted}
          />
        )}
        onScrollToIndexFailed={({ index }) => {
          requestAnimationFrame(() => {
            listRef.current?.scrollToIndex({ index, animated: false });
          });
        }}
      />
    </View>
  );
}

export function firstParam(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

const styles = StyleSheet.create({
  stage: { flex: 1, backgroundColor: "#000" },
});
