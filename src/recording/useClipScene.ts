import { useCallback, useEffect, useMemo, useRef } from "react";
import type { AppSettings, WebcamSettings } from "../types/settings";
import { useSettingsStore } from "../stores/settingsStore";
import { clipLibraryFromSettings, clipLibraryToSettings, seedClipLibrary } from "./clipLibrary";
import type { RecordingSceneLibrary } from "./sceneLibrary";
import { useSceneStudio, type SceneStudioAdapter } from "./useSceneStudio";

/**
 * Settings the Clips studio must never write.
 *
 * These belong to the Recordings studio and to the live capture engine. A clip scene describes
 * how a *saved clip* is framed; it does not decide what Instant Replay records or what the audio
 * engine mixes. Writing any of these from here would silently reconfigure the user's next
 * recording — the exact bleed this studio exists to avoid.
 */
export const CLIP_BANNED_SETTINGS_KEYS = [
  "micEnabled",
  "gameAudioEnabled",
  "systemAudioEnabled",
  "recordingVisuals",
] as const satisfies readonly (keyof AppSettings)[];

/**
 * Webcam fields the Clips studio may write: device and quality, which are genuinely global.
 * Placement, shape and width are per-clip-scene now and live on the source transform instead,
 * and `enabled` drives the camera engine globally — turning the webcam off on a clip scene must
 * only mean "no sidecar for this save".
 */
export const CLIP_ALLOWED_WEBCAM_FIELDS = [
  "deviceId",
  "name",
  "width",
  "height",
  "fps",
  "mirrorPreview",
  "mirrorRecording",
] as const satisfies readonly (keyof WebcamSettings)[];

/** Settings writes fire on every pointer move; batch them before hitting SQLite. */
const CLIP_WRITE_DEBOUNCE_MS = 400;

/**
 * The single gate every Clips-studio settings write passes through. Exported as a pure function
 * so the isolation rule is testable without mounting React.
 *
 * Returns the value to write, or `null` to drop the write entirely.
 */
export function fenceClipSettingsWrite<K extends keyof AppSettings>(
  key: K,
  value: AppSettings[K],
  current: AppSettings,
): AppSettings[K] | null {
  if ((CLIP_BANNED_SETTINGS_KEYS as readonly string[]).includes(key as string)) {
    return null;
  }
  if (key === "webcam") {
    const incoming = value as WebcamSettings;
    const merged: WebcamSettings = { ...current.webcam };
    for (const field of CLIP_ALLOWED_WEBCAM_FIELDS) {
      const next = incoming[field];
      if (next === undefined) continue;
      // Each allowed field is assigned to its own key, so the union of value types is sound.
      Object.assign(merged, { [field]: next });
    }
    return merged as AppSettings[K];
  }
  return value;
}

export function useClipScene() {
  const settings = useSettingsStore((state) => state.settings);
  const update = useSettingsStore((state) => state.update);

  const pending = useRef<RecordingSceneLibrary | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Write any pending scene edit through now.
   *
   * Returns the write so Save Clip can await it: `stage_clip` reads the clip scene straight off
   * the settings document, so an overlay added a moment ago has to be committed before the save
   * reaches Rust, not merely scheduled.
   */
  const flush = useCallback((): Promise<void> => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const library = pending.current;
    if (!library) return Promise.resolve();
    pending.current = null;
    return update("clipStudio", clipLibraryToSettings(library)).catch(() => {
      // A failed clip-layout write is not worth a toast mid-drag; the next commit retries.
    });
  }, [update]);

  const persist = useCallback(
    (library: RecordingSceneLibrary) => {
      pending.current = library;
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(flush, CLIP_WRITE_DEBOUNCE_MS);
    },
    [flush],
  );

  // Never leave an edit stranded in the debounce window.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("beforeunload", flush);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("beforeunload", flush);
      document.removeEventListener("visibilitychange", onHide);
      flush();
    };
  }, [flush]);

  const adapter: SceneStudioAdapter = useMemo(
    () => ({
      load: () => {
        const stored = clipLibraryFromSettings(useSettingsStore.getState().settings);
        const hasScene = stored.scenes.some((scene) => scene.sources.length > 0);
        if (hasScene) return stored;
        // First run: seed from the settings the user already has, and write it through at once
        // so the hotkey and tray paths can see it before the tab is ever touched again.
        const seeded = seedClipLibrary(useSettingsStore.getState().settings);
        void update("clipStudio", clipLibraryToSettings(seeded)).catch(() => {});
        return seeded;
      },
      persist,
      // No `persistActive`: the legacy `replay.recordingScene` key is Recordings-only.
      // No `onCommitted`: clip scenes never push state back into AppSettings.
      // No `inbound`: global settings changes never rewrite a clip scene.
      fence: (key, value) => fenceClipSettingsWrite(key, value, useSettingsStore.getState().settings),
    }),
    [persist, update],
  );

  const studio = useSceneStudio(adapter);

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
    selectScene: studio.selectScene,
    addScene: studio.addScene,
    renameScene: studio.renameScene,
    removeScene: studio.removeScene,
    copyScene: studio.copyScene,
    flush,
    settings,
  };
}
