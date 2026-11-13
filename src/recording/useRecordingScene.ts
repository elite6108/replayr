import { useEffect, useMemo, useRef } from "react";
import type { AppSettings, RecordingVisualSettings, WebcamSettings } from "../types/settings";
import { useRecordingStore } from "../stores/recordingStore";
import { useSettingsStore } from "../stores/settingsStore";
import {
  applySettingsFlags,
  findSourceByType,
  overlayToVisuals,
  persistScene,
  sceneEquals,
  type RecordingScene,
  type RecordingSource,
} from "./scene";
import {
  audioGlobalsForScene,
  effectiveAudio,
  fallbackAudio,
  isSceneAudioType,
  stampAudioFromGlobals,
  type AudioGlobals,
  type SourceAudio,
} from "./sourceAudio";
import { loadOrMigrateLibrary, persistLibrary } from "./sceneLibrary";
import { useSceneStudio, type SceneStudioAdapter } from "./useSceneStudio";

type WriteSettings = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => Promise<void>;

/** Settings keys the Recordings studio owns, in both directions. The Clips studio owns none. */
const RECORDING_INBOUND_KEYS = [
  "webcam",
  "micEnabled",
  "gameAudioEnabled",
  "systemAudioEnabled",
  "recordingVisuals",
] as const satisfies readonly (keyof AppSettings)[];

function webcamFromScene(settings: WebcamSettings, source: RecordingSource | undefined): WebcamSettings {
  if (!source) return { ...settings, enabled: false };
  return {
    ...settings,
    enabled: source.enabled,
    defaultShape:
      source.settings.shape === "rectangle" || source.settings.shape === "rounded" || source.settings.shape === "circle"
        ? source.settings.shape
        : settings.defaultShape,
  };
}

function visualsFromOverlay(source: RecordingSource | undefined, fallback: RecordingVisualSettings): RecordingVisualSettings {
  return overlayToVisuals(source, fallback);
}

export function useRecordingScene() {
  const settings = useSettingsStore((state) => state.settings);
  // `onCommitted` needs the studio's own `writeSettings`, which does not exist until after the
  // adapter is built. The ref closes that loop; it is only read from event handlers.
  const writeSettingsRef = useRef<WriteSettings | null>(null);

  const adapter: SceneStudioAdapter = useMemo(
    () => ({
      load: () => loadOrMigrateLibrary(useSettingsStore.getState().settings),
      persist: persistLibrary,
      persistActive: persistScene,
      onCommitted: (next, previous) => {
        const write = writeSettingsRef.current;
        if (write) syncSettingsFromScene(next, previous, write);
      },
      inbound: applySettingsFlags,
      inboundKeys: RECORDING_INBOUND_KEYS,
      inboundDeps: [
        settings.webcam.enabled,
        settings.webcam.deviceId,
        settings.webcam.defaultShape,
        settings.micEnabled,
        settings.gameAudioEnabled,
        settings.systemAudioEnabled,
        settings.recordingVisuals,
      ],
    }),
    [
      settings.webcam.enabled,
      settings.webcam.deviceId,
      settings.webcam.defaultShape,
      settings.micEnabled,
      settings.gameAudioEnabled,
      settings.systemAudioEnabled,
      settings.recordingVisuals,
    ],
  );

  const studio = useSceneStudio(adapter);
  writeSettingsRef.current = studio.writeSettings;
  const applyingSceneAudio = useRef(false);
  const sceneAudioGeneration = useRef(0);
  const sceneAudioChain = useRef<Promise<void>>(Promise.resolve());
  const studioRef = useRef(studio);
  studioRef.current = studio;

  // A scene that stored its own levels becomes the shared levels, because the engine and the
  // microphone meter both read those. Scenes without a stored level leave the shared ones alone.
  // Writes are queued so a slow save from the scene you just left cannot land on top of this one.
  useEffect(() => {
    const generation = ++sceneAudioGeneration.current;
    const baseline = audioGlobals(useSettingsStore.getState().settings);
    applyingSceneAudio.current = true;
    sceneAudioChain.current = sceneAudioChain.current
      .catch(() => undefined)
      .then(async () => {
        if (sceneAudioGeneration.current !== generation) return;
        const writes = audioGlobalsForScene(studioRef.current.scene.sources, baseline);
        const drifted = audioGlobals(useSettingsStore.getState().settings);
        for (const key of SCENE_AUDIO_KEYS) {
          if (sceneAudioGeneration.current !== generation) return;
          if (writes[key] !== undefined || drifted[key] === baseline[key]) continue;
          await writeAudioGlobal(studioRef.current.writeSettings, key, baseline[key]);
        }
        for (const key of SCENE_AUDIO_KEYS) {
          if (sceneAudioGeneration.current !== generation) return;
          const value = writes[key];
          if (value === undefined) continue;
          await writeAudioGlobal(studioRef.current.writeSettings, key, value);
        }
        if (sceneAudioGeneration.current === generation) applyingSceneAudio.current = false;
      });
  }, [studio.scene.id, primaryAudioKey(studio.scene.sources)]);

  // The Settings page edits the shared levels. Fold them into the active scene when that scene
  // already has its own copy, so leaving and coming back does not restore a stale level.
  useEffect(() => {
    if (applyingSceneAudio.current) return;
    const current = studioRef.current;
    const stamped = stampAudioFromGlobals(current.scene.sources, audioGlobals(useSettingsStore.getState().settings));
    if (!stamped) return;
    const next = { ...current.scene, sources: stamped };
    if (!sceneEquals(current.scene, next)) current.commit(next);
  }, [settings.micGain, settings.microphoneId, settings.systemAudioGain, settings.gameAudioGain, settings.audioOutputId]);

  function saveSourceAudio(id: string, audio: SourceAudio) {
    const current = studio.scene;
    const source = current.sources.find((item) => item.id === id);
    if (!source || !isSceneAudioType(source.type)) return;
    const live = useSettingsStore.getState().settings;
    const recording = useRecordingStore.getState();
    const locked = recording.status.active || recording.startingComposed;
    const currentAudio = effectiveAudio(source.settings, fallbackAudio(source.type, audioGlobals(live)));
    const next =
      locked && (source.type === "microphone" || source.type === "desktopAudio")
        ? { ...audio, deviceId: currentAudio.deviceId }
        : audio;
    studio.patchSource(id, { settings: { ...source.settings, audio: next } });
    const primary = current.sources.find((item) => item.type === source.type);
    if (primary?.id !== id) return;
    if (source.type === "microphone") {
      if (next.gain !== live.micGain) void studio.writeSettings("micGain", next.gain);
      if (next.deviceId !== live.microphoneId) void studio.writeSettings("microphoneId", next.deviceId);
    } else if (source.type === "desktopAudio") {
      if (next.gain !== live.systemAudioGain) void studio.writeSettings("systemAudioGain", next.gain);
      if (next.deviceId !== live.audioOutputId) void studio.writeSettings("audioOutputId", next.deviceId);
    } else if (next.gain !== live.gameAudioGain) {
      void studio.writeSettings("gameAudioGain", next.gain);
    }
  }

  return {
    scene: studio.scene,
    scenes: studio.scenes,
    selected: studio.selected,
    selectedId: studio.selectedId,
    setSelectedId: studio.setSelectedId,
    commit: studio.commit,
    patchSource: studio.patchSource,
    toggleSource: studio.toggleSource,
    addSource: studio.addSource,
    deleteSource: studio.deleteSource,
    setTransform: studio.setTransform,
    setCrop: studio.setCrop,
    beginGesture: studio.beginGesture,
    applyGesture: studio.applyGesture,
    commitGesture: studio.commitGesture,
    cancelGesture: studio.cancelGesture,
    writeSettings: studio.writeSettings,
    saveSourceAudio,
    selectScene: studio.selectScene,
    addScene: studio.addScene,
    importScenes: studio.importScenes,
    renameScene: studio.renameScene,
    removeScene: studio.removeScene,
    moveScene: studio.moveScene,
    copyScene: studio.copyScene,
  };
}

const SCENE_AUDIO_KEYS = ["micGain", "microphoneId", "systemAudioGain", "gameAudioGain", "audioOutputId"] as const satisfies readonly (keyof AudioGlobals)[];

function writeAudioGlobal(write: WriteSettings, key: (typeof SCENE_AUDIO_KEYS)[number], value: AudioGlobals[(typeof SCENE_AUDIO_KEYS)[number]]) {
  if (key === "microphoneId") return write("microphoneId", String(value));
  if (key === "audioOutputId") return write("audioOutputId", String(value));
  if (key === "micGain") return write("micGain", Number(value));
  if (key === "systemAudioGain") return write("systemAudioGain", Number(value));
  return write("gameAudioGain", Number(value));
}

/** Changes when the source that owns the shared microphone, desktop or game level changes. */
function primaryAudioKey(sources: RecordingSource[]): string {
  const mic = sources.find((source) => source.type === "microphone")?.id ?? "";
  const desktop = sources.find((source) => source.type === "desktopAudio")?.id ?? "";
  const game = sources.find((source) => source.type === "gameAudio")?.id ?? "";
  return `${mic}|${desktop}|${game}`;
}

function audioGlobals(settings: AppSettings): AudioGlobals {
  return {
    micGain: settings.micGain,
    microphoneId: settings.microphoneId,
    systemAudioGain: settings.systemAudioGain,
    gameAudioGain: settings.gameAudioGain,
    audioOutputId: settings.audioOutputId,
  };
}

/** The Recordings studio pushes scene state back into global AppSettings. Clips must not. */
function syncSettingsFromScene(
  next: RecordingScene,
  previous: RecordingScene,
  writeSettings: WriteSettings,
) {
  const current = useSettingsStore.getState().settings;
  const prevWebcam = findSourceByType(previous, "webcam");
  const nextWebcam = findSourceByType(next, "webcam");
  const webcamSettings = webcamFromScene(current.webcam, nextWebcam);
  const webcamChanged =
    webcamSettings.enabled !== current.webcam.enabled ||
    webcamSettings.defaultPlacement !== current.webcam.defaultPlacement ||
    webcamSettings.defaultShape !== current.webcam.defaultShape ||
    webcamSettings.defaultWidth !== current.webcam.defaultWidth;
  if (webcamChanged || Boolean(nextWebcam) !== Boolean(prevWebcam)) {
    void writeSettings("webcam", webcamSettings);
  }
  const mic = findSourceByType(next, "microphone");
  if (Boolean(mic?.enabled) !== current.micEnabled) {
    void writeSettings("micEnabled", Boolean(mic?.enabled));
  }
  const gameAudio = findSourceByType(next, "gameAudio");
  if (Boolean(gameAudio?.enabled) !== current.gameAudioEnabled) {
    void writeSettings("gameAudioEnabled", Boolean(gameAudio?.enabled));
  }
  const desktopAudio = findSourceByType(next, "desktopAudio");
  if (Boolean(desktopAudio?.enabled) !== current.systemAudioEnabled) {
    void writeSettings("systemAudioEnabled", Boolean(desktopAudio?.enabled));
  }
  const prevOverlay = findSourceByType(previous, "replayrOverlay");
  const overlay = findSourceByType(next, "replayrOverlay");
  const visuals = overlay
    ? visualsFromOverlay(overlay, current.recordingVisuals)
    : prevOverlay
      ? { filter: "none" as const, overlays: { recIndicator: false, timestamp: false } }
      : current.recordingVisuals;
  const visualsChanged =
    visuals.filter !== current.recordingVisuals.filter ||
    visuals.overlays.recIndicator !== current.recordingVisuals.overlays.recIndicator ||
    visuals.overlays.timestamp !== current.recordingVisuals.overlays.timestamp;
  if (visualsChanged) {
    void writeSettings("recordingVisuals", visuals);
  }
}
