import { useCallback, useEffect, useRef, useState } from "react";
import type { AppSettings, RecordingVisualSettings, WebcamSettings } from "../types/settings";
import { useSettingsStore } from "../stores/settingsStore";
import { useToastStore } from "../stores/toastStore";
import {
  applySettingsFlags,
  createSource,
  findSource,
  findSourceByType,
  isPrimaryCapture,
  loadOrMigrateScene,
  nextOrder,
  overlayToVisuals,
  persistScene,
  removeSource,
  replacePrimary,
  sceneEquals,
  sceneFromPreset,
  setSourceEnabled,
  type RecordingOutputMode,
  type RecordingScene,
  type RecordingSource,
  type RecordingSourceType,
  type ScenePresetId,
  type SourceTransform,
  updateSource,
} from "./scene";

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
  const update = useSettingsStore((state) => state.update);
  const showToast = useToastStore((state) => state.show);
  const [scene, setScene] = useState<RecordingScene>(() => loadOrMigrateScene(useSettingsStore.getState().settings));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const skipInbound = useRef(0);
  const sceneRef = useRef(scene);
  sceneRef.current = scene;

  useEffect(() => {
    persistScene(scene);
  }, [scene]);

  useEffect(() => {
    if (skipInbound.current > 0) {
      skipInbound.current -= 1;
      return;
    }
    setScene((prev) => {
      const next = applySettingsFlags(prev, settings);
      return sceneEquals(prev, next) ? prev : next;
    });
  }, [
    settings.webcam.enabled,
    settings.webcam.deviceId,
    settings.webcam.defaultShape,
    settings.micEnabled,
    settings.gameAudioEnabled,
    settings.systemAudioEnabled,
    settings.recordingVisuals,
  ]);

  const writeSettings = useCallback(
    async <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
      const inbound =
        key === "webcam" ||
        key === "micEnabled" ||
        key === "gameAudioEnabled" ||
        key === "systemAudioEnabled" ||
        key === "recordingVisuals";
      try {
        if (inbound) skipInbound.current += 1;
        await update(key, value);
      } catch (caught) {
        if (inbound) skipInbound.current = Math.max(0, skipInbound.current - 1);
        showToast(caught instanceof Error ? caught.message : "Could not save that setting.");
      }
    },
    [showToast, update],
  );

  const commit = useCallback(
    (next: RecordingScene, previous = sceneRef.current) => {
      persistScene(next);
      setScene(next);
      const current = useSettingsStore.getState().settings;
      const prevWebcam = findSourceByType(previous, "webcam");
      const nextWebcam = findSourceByType(next, "webcam");
      const webcamSettings = webcamFromScene(current.webcam, nextWebcam);
      const webcamChanged =
        webcamSettings.enabled !== current.webcam.enabled ||
        webcamSettings.defaultPlacement !== current.webcam.defaultPlacement ||
        webcamSettings.defaultShape !== current.webcam.defaultShape ||
        webcamSettings.defaultWidth !== current.webcam.defaultWidth;
      const prevHadWebcam = Boolean(prevWebcam);
      if (webcamChanged || Boolean(nextWebcam) !== prevHadWebcam) {
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
    },
    [writeSettings],
  );

  const patchSource = useCallback(
    (id: string, patch: Parameters<typeof updateSource>[2]) => {
      commit(updateSource(sceneRef.current, id, patch));
    },
    [commit],
  );

  const toggleSource = useCallback(
    (id: string, enabled: boolean) => {
      commit(setSourceEnabled(sceneRef.current, id, enabled));
    },
    [commit],
  );

  const addSource = useCallback(
    (type: RecordingSourceType, extra?: { settings?: Record<string, unknown>; name?: string }) => {
      const current = sceneRef.current;
      if (type === "window" || type === "browser" || type === "captureCard" || type === "videoFile" || type === "audioFile") {
        return null;
      }
      if (isPrimaryCapture(type) && (type === "game" || type === "display")) {
        const next = replacePrimary(current, type);
        const added = findSourceByType(next, type);
        commit(next);
        if (added) setSelectedId(added.id);
        return added?.id ?? null;
      }
      const created = createSource(type, {
        order: nextOrder(current.sources),
        enabled: true,
        locked: type === "replayrOverlay",
        name: extra?.name,
        settings: extra?.settings,
        webcam: useSettingsStore.getState().settings.webcam,
      });
      const uniqueExisting = current.sources.find((source) => source.type === type && type !== "image" && type !== "text");
      if (uniqueExisting) {
        setSelectedId(uniqueExisting.id);
        return uniqueExisting.id;
      }
      commit({ ...current, sources: [...current.sources, created] });
      setSelectedId(created.id);
      return created.id;
    },
    [commit],
  );

  const deleteSource = useCallback(
    (id: string) => {
      const next = removeSource(sceneRef.current, id);
      commit(next);
      setSelectedId((current) => (current === id ? null : current));
    },
    [commit],
  );

  const applyPreset = useCallback(
    (preset: ScenePresetId) => {
      const next = sceneFromPreset(preset, useSettingsStore.getState().settings);
      commit(next);
      setSelectedId(primaryOrFirst(next));
    },
    [commit],
  );

  const setOutputMode = useCallback((outputMode: RecordingOutputMode) => {
    commit({ ...sceneRef.current, outputMode });
  }, [commit]);

  const setTransform = useCallback((id: string, transform: SourceTransform) => {
    setScene((prev) => {
      const next = updateSource(prev, id, { transform });
      sceneRef.current = next;
      return next;
    });
  }, []);

  const selected = findSource(scene, selectedId) ?? null;

  return {
    scene,
    selected,
    selectedId,
    setSelectedId,
    commit,
    patchSource,
    toggleSource,
    addSource,
    deleteSource,
    applyPreset,
    setTransform,
    writeSettings,
    setOutputMode,
  };
}

function primaryOrFirst(scene: RecordingScene): string | null {
  return (
    findSourceByType(scene, "game")?.id ??
    findSourceByType(scene, "display")?.id ??
    scene.sources[0]?.id ??
    null
  );
}
