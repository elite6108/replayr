import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { useVideoPlayer, VideoView, type VideoThumbnail } from "expo-video";
import * as MediaLibrary from "expo-media-library";
import * as Sharing from "expo-sharing";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAuth } from "@/lib/auth";
import { fetchBillingStatus, fetchPlayback, type PlaybackClip } from "@/lib/api";
import {
  applyTrim,
  createEditProject,
  outputFrame,
  projectRange,
  type EditProject,
  type FrameAspect,
} from "@/lib/editProject";
import { loadEditProject, readExportJob, saveEditProject } from "@/lib/editProjectStore";
import { cancelRender, renderEdit } from "@/lib/editExport";
import { formatDurationMs } from "@/lib/format";
import { EditorTimeline, formatEditorClock } from "@/components/editor/EditorTimeline";
import { exportAvailable } from "replayr-export";
import { colors } from "@/lib/theme";

type Tool = "trim" | "frame" | "text" | "speed" | "effects" | "clip";
const STRIP_FRAMES = 20;
const TOOLS: { id: Tool; label: string; icon: keyof typeof MaterialCommunityIcons.glyphMap }[] = [
  { id: "trim", label: "Trim", icon: "crop" },
  { id: "frame", label: "Frame", icon: "aspect-ratio" },
  { id: "text", label: "Text", icon: "format-text" },
  { id: "speed", label: "Speed", icon: "speedometer" },
  { id: "effects", label: "Effects", icon: "auto-fix" },
  { id: "clip", label: "Add Clip", icon: "movie-plus-outline" },
];

export default function EditorScreen() {
  const params = useLocalSearchParams<{ slug?: string | string[] }>();
  const slug = Array.isArray(params.slug) ? params.slug[0] : params.slug;
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { session } = useAuth();
  const [clip, setClip] = useState<PlaybackClip | null>(null);
  const [project, setProject] = useState<EditProject | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>("trim");
  const [watermark, setWatermark] = useState<boolean | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportLabel, setExportLabel] = useState("Preparing clip…");
  const [outputPath, setOutputPath] = useState<string | null>(null);
  const [sheet, setSheet] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [frameWidth, setFrameWidth] = useState(0);
  const [frames, setFrames] = useState<VideoThumbnail[]>([]);
  const [currentMs, setCurrentMs] = useState(0);
  const [fps, setFps] = useState<number | null>(null);
  const stripFor = useRef<string | null>(null);

  const player = useVideoPlayer(clip?.playbackUrl ?? null, (instance) => {
    instance.loop = false;
    instance.timeUpdateEventInterval = 0.05;
  });

  useEffect(() => {
    if (!slug || !session?.access_token) return;
    let cancelled = false;
    void (async () => {
      try {
        const [next, billing, interrupted] = await Promise.all([
          fetchPlayback(slug, session.access_token),
          fetchBillingStatus(session.access_token).catch(() => null),
          readExportJob(),
        ]);
        if (cancelled) return;
        if (!next.mine || !next.id || !next.durationMs || !next.width || !next.height) {
          setError("Only your own cloud clips can be edited.");
          return;
        }
        const fresh = createEditProject({
          id: next.id,
          slug: next.slug,
          durationMs: next.durationMs,
          width: next.width,
          height: next.height,
        });
        const saved = await loadEditProject(next.slug, next.id);
        if (cancelled) return;
        setClip(next);
        setProject(saved ?? fresh);
        setWatermark(billing ? billing.watermark : null);
        if (interrupted?.slug === next.slug && interrupted.status === "interrupted") {
          setNotice(interrupted.errorMessage);
        }
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Could not open that clip.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug, session?.access_token]);

  useEffect(() => {
    if (!project) return;
    const timer = setTimeout(() => {
      void saveEditProject(project);
    }, 300);
    return () => clearTimeout(timer);
  }, [project]);

  const range = project ? projectRange(project) : { startMs: 0, endMs: 0 };
  const frame = project ? outputFrame(project) : null;
  const durationMs = project?.source.durationMs ?? 1;

  useEffect(() => {
    const url = clip?.playbackUrl;
    const durationSec = (project?.source.durationMs ?? 0) / 1000;
    if (!player || !url || durationSec <= 0) return;
    let cancelled = false;
    const load = () => {
      if (stripFor.current === url) return;
      stripFor.current = url;
      const times = Array.from({ length: STRIP_FRAMES }, (_, index) => ((index + 0.5) / STRIP_FRAMES) * durationSec);
      void player
        .generateThumbnailsAsync(times, { maxHeight: 96 })
        .then((next) => {
          if (!cancelled && next.length > 0) setFrames(next);
        })
        .catch(() => {
          if (stripFor.current === url) stripFor.current = null;
        });
    };
    if (player.status === "readyToPlay") load();
    const sub = player.addListener("statusChange", ({ status }) => {
      if (status === "readyToPlay") load();
    });
    return () => {
      cancelled = true;
      sub.remove();
    };
  }, [player, clip?.playbackUrl, project?.source.durationMs]);

  useEffect(() => {
    if (!player || !project) return;
    const sub = player.addListener("timeUpdate", ({ currentTime }) => {
      const ms = currentTime * 1000;
      setCurrentMs(ms);
      if (ms < range.startMs - 40) player.currentTime = range.startMs / 1000;
      if (ms >= range.endMs) {
        player.pause();
        player.currentTime = range.startMs / 1000;
        setCurrentMs(range.startMs);
        setPlaying(false);
      }
    });
    return () => sub.remove();
  }, [player, project, range.startMs, range.endMs]);

  useEffect(() => {
    if (!player || !project) return;
    player.muted = project.audio.muted || project.audio.volume <= 0;
    player.volume = project.audio.volume;
  }, [player, project]);

  useEffect(() => {
    if (!player) return;
    const read = () => {
      const rate = player.videoTrack?.frameRate;
      if (rate && rate > 1) setFps(Math.round(rate));
    };
    read();
    const sub = player.addListener("videoTrackChange", () => read());
    return () => sub.remove();
  }, [player]);

  const update = useCallback((next: EditProject) => setProject(next), []);

  const seek = (ms: number) => {
    const next = Math.max(0, Math.min(durationMs, ms));
    player.currentTime = next / 1000;
    setCurrentMs(next);
  };

  const previewAspect = frame ? frame.outWidth / frame.outHeight : 16 / 9;

  const runExport = async () => {
    if (!project || !clip?.playbackUrl || !session?.access_token) return;
    if (!exportAvailable()) {
      Alert.alert("Export needs a development build", "This install does not include the on-device encoder.");
      return;
    }
    let burn = watermark;
    if (burn == null) {
      try {
        burn = (await fetchBillingStatus(session.access_token)).watermark;
        setWatermark(burn);
      } catch {
        Alert.alert("Could not verify your plan", "Export stays closed until Replayr can confirm whether this clip needs a watermark.");
        return;
      }
    }
    setExporting(true);
    setExportLabel("Preparing clip…");
    setOutputPath(null);
    try {
      const result = await renderEdit({
        project,
        playbackUrl: clip.playbackUrl,
        watermark: burn,
        onProgress: (event) => {
          if (event.status === "preparing") setExportLabel("Preparing clip…");
          else setExportLabel(`Exporting ${Math.round(event.progress * 100)}%`);
        },
      });
      setOutputPath(result.path);
      setExportLabel("Export ready");
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Export failed.";
      if (!/cancel/i.test(message)) Alert.alert("Export failed", message);
      setSheet(false);
    } finally {
      setExporting(false);
    }
  };

  const savePhotos = async () => {
    if (!outputPath) return;
    const permission = await MediaLibrary.requestPermissionsAsync(true);
    if (permission.status !== "granted") {
      Alert.alert("Photos access is off", "Replayr needs permission to save the exported clip.");
      return;
    }
    await MediaLibrary.saveToLibraryAsync(outputPath);
    Alert.alert("Saved to Photos", "The original cloud clip was not changed.");
  };

  const share = async () => {
    if (!outputPath) return;
    if (!(await Sharing.isAvailableAsync())) {
      Alert.alert("Sharing is not available on this device.");
      return;
    }
    await Sharing.shareAsync(outputPath, { mimeType: "video/mp4", UTI: "public.mpeg-4" });
  };

  const aspects = useMemo(() => ["original", "16:9", "9:16"] as FrameAspect[], []);

  return (
    <View style={[styles.page, { paddingTop: insets.top }]}>
      <Stack.Screen
        options={{
          headerShown: false,
          gestureDirection: "horizontal",
          fullScreenGestureEnabled: false,
          gestureResponseDistance: { start: 16 },
        }}
      />
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12} style={styles.back}>
          <Ionicons name="chevron-back" size={22} color={colors.text} />
        </Pressable>
        <View style={styles.titleBlock}>
          <Text style={styles.title} numberOfLines={1}>
            {clip?.title || "Edit"}
          </Text>
          {project ? (
            <Text style={styles.meta} numberOfLines={1}>
              {formatDurationMs(project.source.durationMs)} · {project.source.width} × {project.source.height}
              {fps ? ` · ${fps} FPS` : ""}
            </Text>
          ) : null}
        </View>
        <Pressable onPress={() => setSheet(true)} disabled={!project} style={styles.exportBtn}>
          <Text style={styles.exportText}>Export</Text>
        </Pressable>
      </View>
      {error ? (
        <View style={styles.center}>
          <Text style={styles.error}>{error}</Text>
        </View>
      ) : !project || !clip ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : (
        <>
          <View style={styles.stage}>
            <View
              style={[styles.frame, { aspectRatio: previewAspect }]}
              onLayout={(event) => setFrameWidth(event.nativeEvent.layout.width)}
            >
              <View
                style={{
                  flex: 1,
                  transform: [
                    {
                      translateX:
                        project.frame.aspect === "original" || !frameWidth
                          ? 0
                          : (0.5 - project.frame.pan) *
                            frameWidth *
                            Math.max(0, project.source.width / project.source.height / previewAspect - 1),
                    },
                  ],
                }}
              >
                <VideoView player={player} style={StyleSheet.absoluteFill} contentFit="cover" nativeControls={false} />
              </View>
            </View>
            <Scrubber progress={currentMs / durationMs} onSeek={(ratio) => seek(ratio * durationMs)} />
          </View>
          <View style={styles.clockRow}>
            <Text style={styles.clock}>
              {formatEditorClock(currentMs)} <Text style={styles.clockDim}>/ {formatEditorClock(durationMs)}</Text>
            </Text>
            <View style={styles.volume}>
              <Pressable
                hitSlop={8}
                onPress={() => update({ ...project, audio: { ...project.audio, muted: !project.audio.muted } })}
              >
                <Ionicons name={project.audio.muted || project.audio.volume <= 0 ? "volume-mute" : "volume-medium"} size={16} color={colors.text} />
              </Pressable>
              <PanSlider
                value={project.audio.muted ? 0 : project.audio.volume}
                onChange={(volume) => update({ ...project, audio: { ...project.audio, volume, muted: false } })}
              />
            </View>
          </View>
          <View style={styles.transport}>
            <Pressable hitSlop={8} onPress={() => seek(currentMs - 5000)}>
              <Ionicons name="play-skip-back" size={22} color={colors.text} />
            </Pressable>
            <Pressable
              style={styles.play}
              onPress={() => {
                if (playing) {
                  player.pause();
                  setPlaying(false);
                  return;
                }
                if (player.currentTime * 1000 < range.startMs || player.currentTime * 1000 >= range.endMs) {
                  seek(range.startMs);
                }
                player.play();
                setPlaying(true);
              }}
            >
              <Ionicons name={playing ? "pause" : "play"} size={22} color={colors.text} style={playing ? undefined : { marginLeft: 2 }} />
            </Pressable>
            <Pressable hitSlop={8} onPress={() => seek(currentMs + 5000)}>
              <Ionicons name="play-skip-forward" size={22} color={colors.text} />
            </Pressable>
          </View>
          {notice ? <Text style={styles.notice}>{notice}</Text> : null}
          <EditorTimeline
            durationMs={durationMs}
            currentMs={currentMs}
            rangeStartMs={range.startMs}
            rangeEndMs={range.endMs}
            frames={frames}
            thumbnailUrl={clip.thumbnailUrl}
            trimEnabled={tool === "trim"}
            playing={playing}
            onSeek={seek}
            onTrim={(edge, ms) =>
              update(applyTrim(project, edge === "start" ? ms : range.startMs, edge === "end" ? ms : range.endMs))
            }
          />
          {tool === "frame" ? (
            <View style={styles.panel}>
              <View style={styles.row}>
                {aspects.map((aspect) => (
                  <Pressable
                    key={aspect}
                    style={[styles.chip, project.frame.aspect === aspect && styles.chipOn]}
                    onPress={() => update({ ...project, frame: { ...project.frame, aspect } })}
                  >
                    <Text style={styles.chipText}>{aspect === "original" ? "Original" : aspect}</Text>
                  </Pressable>
                ))}
              </View>
              {project.frame.aspect !== "original" ? (
                <PanSlider
                  wide
                  value={project.frame.pan}
                  onChange={(pan) => update({ ...project, frame: { ...project.frame, pan } })}
                />
              ) : null}
            </View>
          ) : null}
          {tool === "text" || tool === "speed" || tool === "effects" || tool === "clip" ? (
            <Text style={styles.hint}>
              {tool === "text"
                ? "Text overlays are next."
                : tool === "speed"
                  ? "Speed changes are next."
                  : tool === "effects"
                    ? "Effects are next."
                    : "Adding another clip is next."}
            </Text>
          ) : null}
          <View style={[styles.tools, { paddingBottom: Math.max(insets.bottom, 8) }]}>
            {TOOLS.map((item) => (
              <Pressable key={item.id} onPress={() => setTool(item.id)} style={styles.tool}>
                <MaterialCommunityIcons name={item.icon} size={20} color={tool === item.id ? colors.accent : colors.muted} />
                <Text style={[styles.toolText, tool === item.id && styles.toolOn]}>{item.label}</Text>
              </Pressable>
            ))}
          </View>
        </>
      )}
      {sheet ? (
        <View style={styles.sheetWrap}>
          <Pressable style={styles.dim} onPress={() => !exporting && setSheet(false)} />
          <View style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]}>
            <Text style={styles.sheetTitle}>Export</Text>
            <Text style={styles.hint}>1080p H.264 on this phone. The cloud original is not replaced.</Text>
            {watermark ? <Text style={styles.hint}>A Replayr watermark is included on this plan.</Text> : null}
            <Text style={styles.exportLabel}>{exporting || outputPath ? exportLabel : "Ready"}</Text>
            {exporting ? (
              <Pressable
                style={styles.secondary}
                onPress={() => {
                  cancelRender();
                }}
              >
                <Text style={styles.secondaryText}>Cancel</Text>
              </Pressable>
            ) : outputPath ? (
              <View style={styles.row}>
                <Pressable style={styles.primary} onPress={() => void savePhotos()}>
                  <Text style={styles.primaryText}>Save to Photos</Text>
                </Pressable>
                <Pressable style={styles.secondary} onPress={() => void share()}>
                  <Text style={styles.secondaryText}>Share</Text>
                </Pressable>
              </View>
            ) : (
              <Pressable style={styles.primary} onPress={() => void runExport()}>
                <Text style={styles.primaryText}>Export</Text>
              </Pressable>
            )}
          </View>
        </View>
      ) : null}
    </View>
  );
}

function Scrubber({ progress, onSeek }: { progress: number; onSeek: (ratio: number) => void }) {
  const width = useRef(1);
  const seekAt = (x: number) => onSeek(Math.max(0, Math.min(1, x / width.current)));
  return (
    <View
      style={styles.scrubber}
      onLayout={(event) => {
        width.current = event.nativeEvent.layout.width;
      }}
      onStartShouldSetResponder={() => true}
      onResponderMove={(event) => seekAt(event.nativeEvent.locationX)}
      onResponderRelease={(event) => seekAt(event.nativeEvent.locationX)}
    >
      <View style={styles.scrubTrack} />
      <View style={[styles.scrubFill, { width: `${Math.max(0, Math.min(1, progress)) * 100}%` }]} />
      <View style={[styles.scrubThumb, { left: `${Math.max(0, Math.min(1, progress)) * 100}%` }]} />
    </View>
  );
}

function PanSlider({ value, onChange, wide }: { value: number; onChange: (value: number) => void; wide?: boolean }) {
  const width = useRef(1);
  return (
    <View
      style={[styles.slider, wide && styles.sliderWide]}
      onLayout={(event) => {
        width.current = event.nativeEvent.layout.width;
      }}
      onStartShouldSetResponder={() => true}
      onResponderMove={(event) => onChange(Math.max(0, Math.min(1, event.nativeEvent.locationX / width.current)))}
      onResponderRelease={(event) => onChange(Math.max(0, Math.min(1, event.nativeEvent.locationX / width.current)))}
    >
      <View style={[styles.sliderFill, { width: `${value * 100}%` }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: "#070b12" },
  header: { height: 52, flexDirection: "row", alignItems: "center", paddingHorizontal: 8, gap: 8 },
  back: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
  titleBlock: { flex: 1 },
  title: { color: colors.text, fontSize: 16, fontWeight: "700" },
  meta: { color: colors.muted, fontSize: 11, marginTop: 1 },
  exportBtn: { backgroundColor: colors.accent, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 8 },
  exportText: { color: "#041418", fontWeight: "800", fontSize: 14 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  error: { color: colors.danger, textAlign: "center" },
  stage: { flex: 1, justifyContent: "center", paddingHorizontal: 16, gap: 8 },
  frame: { width: "100%", maxHeight: "86%", backgroundColor: "#000", overflow: "hidden", borderRadius: 12 },
  scrubber: { height: 18, justifyContent: "center" },
  scrubTrack: { height: 3, borderRadius: 2, backgroundColor: "#243041" },
  scrubFill: { position: "absolute", left: 0, height: 3, borderRadius: 2, backgroundColor: colors.accent },
  scrubThumb: {
    position: "absolute",
    width: 12,
    height: 12,
    marginLeft: -6,
    borderRadius: 6,
    backgroundColor: colors.accent,
  },
  clockRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingTop: 2 },
  clock: { color: colors.text, fontVariant: ["tabular-nums"], fontSize: 13, fontWeight: "600" },
  clockDim: { color: colors.muted, fontWeight: "500" },
  volume: { flexDirection: "row", alignItems: "center", gap: 8 },
  transport: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 28, paddingVertical: 6 },
  play: {
    width: 42,
    height: 42,
    borderRadius: 21,
    borderWidth: 1.5,
    borderColor: "#2a3544",
    alignItems: "center",
    justifyContent: "center",
  },
  notice: { color: colors.muted, fontSize: 12, paddingHorizontal: 16 },
  panel: { paddingHorizontal: 16, paddingTop: 4, gap: 8 },
  hint: { color: colors.muted, fontSize: 12, paddingHorizontal: 16, paddingBottom: 4 },
  row: { flexDirection: "row", gap: 8, alignItems: "center" },
  chip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: "#243041" },
  chipOn: { borderColor: colors.accent, backgroundColor: "rgba(0,216,240,0.12)" },
  chipText: { color: colors.text, fontSize: 13, fontWeight: "600" },
  slider: { width: 88, height: 22, borderRadius: 8, backgroundColor: "#1a2330", justifyContent: "center" },
  sliderWide: { width: "100%" },
  sliderFill: { height: 3, borderRadius: 2, backgroundColor: colors.muted },
  tools: { flexDirection: "row", borderTopWidth: 1, borderTopColor: "#1c2633", marginTop: 4 },
  tool: { flex: 1, alignItems: "center", justifyContent: "center", gap: 4, paddingVertical: 8 },
  toolText: { color: colors.muted, fontSize: 10, fontWeight: "600" },
  toolOn: { color: colors.accent },
  sheetWrap: { ...StyleSheet.absoluteFill, justifyContent: "flex-end" },
  dim: { ...StyleSheet.absoluteFill, backgroundColor: "#00000088" },
  sheet: { backgroundColor: "#101820", borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 16, gap: 10 },
  sheetTitle: { color: colors.text, fontSize: 18, fontWeight: "700" },
  exportLabel: { color: colors.text, fontVariant: ["tabular-nums"] },
  primary: { backgroundColor: colors.accent, borderRadius: 10, paddingVertical: 12, paddingHorizontal: 16 },
  primaryText: { color: "#041418", fontWeight: "700", textAlign: "center" },
  secondary: { borderRadius: 10, paddingVertical: 12, paddingHorizontal: 16, borderWidth: 1, borderColor: "#243041" },
  secondaryText: { color: colors.text, fontWeight: "600", textAlign: "center" },
});
