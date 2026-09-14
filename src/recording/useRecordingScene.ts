import { useCallback, useMemo, useRef } from "react";
import type { AppSettings, RecordingVisualSettings, WebcamSettings } from "../types/settings";
import { useSettingsStore } from "../stores/settingsStore";
import {
  applySettingsFlags,
  findSourceByType,
  overlayToVisuals,
  persistScene,
  type RecordingOutputMode,
  type RecordingScene,
  type RecordingSource,
} from "./scene";
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

  const { commit, scene } = studio;
  const setOutputMode = useCallback(
    (outputMode: RecordingOutputMode) => {
      commit({ ...scene, outputMode });
    },
    [commit, scene],
  );

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
    writeSettings: studio.writeSettings,
    setOutputMode,
    selectScene: studio.selectScene,
    addScene: studio.addScene,
    renameScene: studio.renameScene,
    removeScene: studio.removeScene,
    copyScene: studio.copyScene,
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
