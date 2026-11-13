import { useCallback, useEffect, useRef, useState } from "react";
import type { AppSettings } from "../types/settings";
import { useSettingsStore } from "../stores/settingsStore";
import { useToastStore } from "../stores/toastStore";
import {
  clampCrop,
  clampTransform,
  createSource,
  FULL_CROP,
  FULL_FRAME,
  findSource,
  findSourceByType,
  isPrimaryCapture,
  nextOrder,
  removeSource,
  replacePrimary,
  sceneEquals,
  setSourceEnabled,
  type RecordingScene,
  type RecordingSourceType,
  type ScenePresetId,
  type SourceCrop,
  type SourceTransform,
  updateSource,
} from "./scene";
import { MAX_MICROPHONES } from "./sourceAudio";
import { cornerTransform, MAX_DISPLAYS, MAX_WEBCAMS, MAX_WINDOWS } from "./sourceVisual";
import {
  activeSceneOf,
  appendScenes,
  createScene,
  MAX_SCENE_LIBRARY,
  deleteScene,
  duplicateScene,
  moveScene,
  renameScene,
  replaceActive,
  switchScene,
  type RecordingSceneLibrary,
} from "./sceneLibrary";

/**
 * How one studio differs from another.
 *
 * The state machine below is shared by the Recordings and Clips tabs. Everything that is
 * studio-specific — where the library is stored, whether scene edits write back into global
 * AppSettings, and which settings keys feed back into the scene — lives in this adapter.
 *
 * The Clips studio supplies no `onCommitted` and no `inbound`, which is what structurally
 * guarantees it can never overwrite the Recordings studio's audio or visual settings.
 */
export type SceneStudioAdapter = {
  /** Read the library for this studio. Called once, on mount. */
  load: () => RecordingSceneLibrary;
  /** Write the library for this studio. */
  persist: (library: RecordingSceneLibrary) => void;
  /** Extra per-render persistence. Recordings mirrors the active scene to the legacy key. */
  persistActive?: (scene: RecordingScene) => void;
  /** Push scene state back into AppSettings after a commit. Recordings only. */
  onCommitted?: (next: RecordingScene, previous: RecordingScene) => void;
  /** Pull AppSettings back into the scene when they change. Recordings only. */
  inbound?: (scene: RecordingScene, settings: AppSettings) => RecordingScene;
  /** Values that trigger `inbound`. Must be a stable-length list. */
  inboundDeps?: readonly unknown[];
  /** Settings keys whose own writes must not echo back through `inbound`. */
  inboundKeys?: readonly (keyof AppSettings)[];
  /**
   * Last gate before a settings write. Return `null` to drop it. The Clips studio uses this to
   * refuse the keys it must never own, so the rule is enforced in one testable place.
   */
  fence?: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => AppSettings[K] | null;
};

export function useSceneStudio(adapter: SceneStudioAdapter) {
  const settings = useSettingsStore((state) => state.settings);
  const update = useSettingsStore((state) => state.update);
  const showToast = useToastStore((state) => state.show);
  // The adapter is rebuilt every render, so read it through a ref rather than depending on it.
  const adapterRef = useRef(adapter);
  adapterRef.current = adapter;

  const [library, setLibrary] = useState<RecordingSceneLibrary>(() => adapter.load());
  const scene = activeSceneOf(library);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const skipInbound = useRef(0);
  const libraryRef = useRef(library);
  const sceneRef = useRef(scene);
  libraryRef.current = library;
  sceneRef.current = scene;

  const gestureHold = useRef(false);
  const gestureRef = useRef<{
    sceneId: string;
    sourceId: string;
    transform: SourceTransform;
    crop: SourceCrop;
  } | null>(null);

  useEffect(() => {
    if (gestureHold.current) return;
    adapterRef.current.persist(library);
    adapterRef.current.persistActive?.(scene);
  }, [library, scene]);

  useEffect(() => {
    return () => {
      const gesture = gestureRef.current;
      if (!gestureHold.current || !gesture) return;
      gestureHold.current = false;
      gestureRef.current = null;
      if (activeSceneOf(libraryRef.current).id !== gesture.sceneId) return;
      adapterRef.current.persist(libraryRef.current);
      adapterRef.current.persistActive?.(activeSceneOf(libraryRef.current));
    };
  }, []);

  const inboundDeps = adapter.inboundDeps ?? [];
  useEffect(() => {
    const inbound = adapterRef.current.inbound;
    if (!inbound) return;
    if (skipInbound.current > 0) {
      skipInbound.current -= 1;
      return;
    }
    setLibrary((prev) => {
      const current = activeSceneOf(prev);
      const nextScene = inbound(current, useSettingsStore.getState().settings);
      if (sceneEquals(current, nextScene)) return prev;
      return replaceActive(prev, nextScene);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, inboundDeps);

  const writeSettings = useCallback(
    async <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
      const current = adapterRef.current;
      const allowed = current.fence ? current.fence(key, value) : value;
      if (allowed === null) return;
      const inbound = Boolean(current.inbound) && (current.inboundKeys ?? []).includes(key);
      try {
        if (inbound) skipInbound.current += 1;
        await update(key, allowed);
      } catch (caught) {
        if (inbound) skipInbound.current = Math.max(0, skipInbound.current - 1);
        showToast(caught instanceof Error ? caught.message : "Could not save that setting.");
      }
    },
    [showToast, update],
  );

  const writeLibrary = useCallback((next: RecordingSceneLibrary, previous = sceneRef.current) => {
    const clean = next;
    adapterRef.current.persist(clean);
    setLibrary(clean);
    const upcoming = activeSceneOf(clean);
    adapterRef.current.onCommitted?.(upcoming, previous);
  }, []);

  const commit = useCallback(
    (next: RecordingScene, previous = sceneRef.current) => {
      writeLibrary(replaceActive(libraryRef.current, next), previous);
    },
    [writeLibrary],
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
      if (type === "game") {
        const next = replacePrimary(current, type);
        const added = findSourceByType(next, type);
        commit(next);
        if (added) setSelectedId(added.id);
        return added?.id ?? null;
      }
      if (type === "display" && current.sources.every((source) => source.type !== "display")) {
        const next = replacePrimary(current, type);
        const added = findSourceByType(next, type);
        commit(next);
        if (added) setSelectedId(added.id);
        return added?.id ?? null;
      }
      const microphoneCount = current.sources.filter((source) => source.type === "microphone").length;
      if (type === "microphone" && microphoneCount >= MAX_MICROPHONES) {
        showToast(`You can add up to ${MAX_MICROPHONES} microphones in one scene.`);
        return null;
      }
      const displayCount = current.sources.filter((source) => source.type === "display").length;
      const windowCount = current.sources.filter((source) => source.type === "window").length;
      const webcamCount = current.sources.filter((source) => source.type === "webcam").length;
      if (type === "display" && displayCount >= MAX_DISPLAYS) {
        showToast(`You can add up to ${MAX_DISPLAYS} displays in one scene.`);
        return null;
      }
      if (type === "window" && windowCount >= MAX_WINDOWS) {
        showToast(`You can add up to ${MAX_WINDOWS} windows in one scene.`);
        return null;
      }
      const cardCount = current.sources.filter((source) => source.type === "captureCard").length;
      const videoCount = current.sources.filter((source) => source.type === "videoFile").length;
      const audioCount = current.sources.filter((source) => source.type === "audioFile").length;
      const browserCount = current.sources.filter((source) => source.type === "browser").length;
      if (type === "webcam" && webcamCount >= MAX_WEBCAMS) {
        showToast(`You can add up to ${MAX_WEBCAMS} webcams in one scene.`);
        return null;
      }
      if (type === "captureCard" && webcamCount + cardCount >= MAX_WEBCAMS) {
        showToast(`You can add up to ${MAX_WEBCAMS} cameras and capture cards in one scene.`);
        return null;
      }
      if (type === "videoFile" && videoCount >= 4) {
        showToast("You can add up to 4 video files in one scene.");
        return null;
      }
      if (type === "audioFile" && audioCount >= 4) {
        showToast("You can add up to 4 audio files in one scene.");
        return null;
      }
      if (type === "browser" && browserCount >= 2) {
        showToast("You can add up to 2 browser sources in one scene.");
        return null;
      }
      const layered = type === "display" || type === "window";
      const hasCapture = current.sources.some((source) => isPrimaryCapture(source.type));
      const created = createSource(type, {
        order: nextOrder(current.sources),
        enabled: true,
        locked: type === "replayrOverlay" || (layered && !hasCapture),
        name:
          extra?.name ??
          (type === "microphone" && microphoneCount > 0
            ? `Microphone ${microphoneCount + 1}`
            : type === "webcam" && webcamCount > 0
              ? `Webcam ${webcamCount + 1}`
              : type === "display" && displayCount > 0
                ? `Desktop ${displayCount + 1}`
                : type === "window" && windowCount > 0
                  ? `Window ${windowCount + 1}`
                  : undefined),
        transform: layered && hasCapture ? clampTransform(cornerTransform(type === "display" ? displayCount : windowCount)) : layered ? { ...FULL_FRAME } : undefined,
        settings: extra?.settings,
        webcam: useSettingsStore.getState().settings.webcam,
      });
      const uniqueExisting =
        type === "microphone" || type === "image" || type === "text" || type === "webcam" || type === "display" || type === "window"
          ? undefined
          : current.sources.find((source) => source.type === type);
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

  // Transform and crop deliberately bypass `writeLibrary`: they fire on every pointer move and
  // never need to touch AppSettings, which is what already made them safe to share.
  const setTransform = useCallback((id: string, transform: SourceTransform) => {
    setLibrary((prev) => {
      const next = replaceActive(prev, updateSource(activeSceneOf(prev), id, { transform }));
      adapterRef.current.persist(next);
      return next;
    });
  }, []);

  const setCrop = useCallback((id: string, crop: SourceCrop) => {
    setLibrary((prev) => {
      const next = replaceActive(prev, updateSource(activeSceneOf(prev), id, { crop: clampCrop(crop) }));
      adapterRef.current.persist(next);
      return next;
    });
  }, []);

  const beginGesture = useCallback((sourceId: string) => {
    const current = sceneRef.current;
    const source = findSource(current, sourceId);
    if (!source?.transform) return;
    gestureHold.current = true;
    gestureRef.current = {
      sceneId: current.id,
      sourceId,
      transform: source.transform,
      crop: source.crop ?? FULL_CROP,
    };
  }, []);

  const applyGesture = useCallback((sourceId: string, patch: { transform?: SourceTransform; crop?: SourceCrop }) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.sourceId !== sourceId || gesture.sceneId !== sceneRef.current.id) return;
    setLibrary((prev) => {
      if (activeSceneOf(prev).id !== gesture.sceneId) return prev;
      const nextPatch = patch.crop ? { ...patch, crop: clampCrop(patch.crop) } : patch;
      return replaceActive(prev, updateSource(activeSceneOf(prev), sourceId, nextPatch));
    });
  }, []);

  const commitGesture = useCallback(() => {
    const gesture = gestureRef.current;
    gestureRef.current = null;
    gestureHold.current = false;
    if (!gesture) return;
    if (activeSceneOf(libraryRef.current).id !== gesture.sceneId) return;
    adapterRef.current.persist(libraryRef.current);
    adapterRef.current.persistActive?.(activeSceneOf(libraryRef.current));
  }, []);

  const cancelGesture = useCallback(() => {
    const gesture = gestureRef.current;
    gestureRef.current = null;
    gestureHold.current = false;
    if (!gesture) return;
    setLibrary((prev) => {
      if (activeSceneOf(prev).id !== gesture.sceneId) return prev;
      const next = replaceActive(
        prev,
        updateSource(activeSceneOf(prev), gesture.sourceId, {
          transform: gesture.transform,
          crop: gesture.crop,
        }),
      );
      adapterRef.current.persist(next);
      adapterRef.current.persistActive?.(activeSceneOf(next));
      return next;
    });
  }, []);

  const selectScene = useCallback(
    (id: string) => {
      const previous = sceneRef.current;
      const next = switchScene(libraryRef.current, id);
      writeLibrary(next, previous);
      setSelectedId(primaryOrFirst(activeSceneOf(next)));
    },
    [writeLibrary],
  );

  const addScene = useCallback(
    (name: string, template: ScenePresetId | null) => {
      const result = createScene(libraryRef.current, useSettingsStore.getState().settings, { name, template });
      if ("error" in result) {
        showToast(result.error);
        return;
      }
      writeLibrary(result, sceneRef.current);
      setSelectedId(primaryOrFirst(activeSceneOf(result)));
    },
    [showToast, writeLibrary],
  );

  /** Append already-built scenes (for example from OBS) and switch to the first one added. */
  const importScenes = useCallback(
    (incoming: RecordingScene[]): { added: number; dropped: number } => {
      const result = appendScenes(libraryRef.current, incoming);
      if (!result.added) {
        showToast(`You can keep up to ${MAX_SCENE_LIBRARY} scenes. Delete some to import more.`);
        return { added: 0, dropped: result.dropped };
      }
      writeLibrary(result.library, sceneRef.current);
      setSelectedId(primaryOrFirst(activeSceneOf(result.library)));
      return { added: result.added, dropped: result.dropped };
    },
    [showToast, writeLibrary],
  );

  const renameActiveOrId = useCallback(
    (id: string, name: string) => {
      writeLibrary(renameScene(libraryRef.current, id, name), sceneRef.current);
    },
    [writeLibrary],
  );

  const removeScene = useCallback(
    (id: string) => {
      const result = deleteScene(libraryRef.current, id);
      if ("error" in result) {
        showToast(result.error);
        return;
      }
      writeLibrary(result, sceneRef.current);
      setSelectedId(primaryOrFirst(activeSceneOf(result)));
    },
    [showToast, writeLibrary],
  );

  const shiftScene = useCallback(
    (id: string, direction: "up" | "down") => {
      writeLibrary(moveScene(libraryRef.current, id, direction), sceneRef.current);
    },
    [writeLibrary],
  );

  const copyScene = useCallback(
    (id: string) => {
      const result = duplicateScene(libraryRef.current, id);
      if ("error" in result) {
        showToast(result.error);
        return;
      }
      writeLibrary(result, sceneRef.current);
      setSelectedId(primaryOrFirst(activeSceneOf(result)));
    },
    [showToast, writeLibrary],
  );

  const selected = findSource(scene, selectedId) ?? null;

  return {
    scene,
    scenes: library.scenes,
    selected,
    selectedId,
    setSelectedId,
    commit,
    patchSource,
    toggleSource,
    addSource,
    deleteSource,
    setTransform,
    setCrop,
    beginGesture,
    applyGesture,
    commitGesture,
    cancelGesture,
    writeSettings,
    selectScene,
    addScene,
    importScenes,
    renameScene: renameActiveOrId,
    removeScene,
    moveScene: shiftScene,
    copyScene,
    settings,
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
