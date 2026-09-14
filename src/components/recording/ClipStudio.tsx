import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { getCameraStatus } from "../../services/tauri";
import { useRecordingStore } from "../../stores/recordingStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { IDLE_CAMERA_STATUS, type CameraDevice, type CameraStatus } from "../../types/camera";
import { DEFAULT_RECORDING_VISUALS } from "../../types/settings";
import { findSourceByType, type RecordingSourceType } from "../../recording/scene";
import { useDisplays } from "../../recording/display/useDisplays";
import { useClipScene } from "../../recording/useClipScene";
import { useStudioAudio } from "../../recording/useStudioAudio";
import { AudioMixer } from "./AudioMixer";
import { IrControlsCard } from "./IrControlsCard";
import { IrEncoderDetails } from "../common/IrEncoderDetails";
import { RecordingPreview } from "./RecordingPreview";
import { SourceInspector } from "./SourceInspector";
import { SourceList } from "./SourceList";
import { SourcePropertiesDialog } from "./SourcePropertiesDialog";

/** Minutes east of UTC, matching what `new Date()` renders in the preview. */
function tzOffsetMinutes(): number {
  return -new Date().getTimezoneOffset();
}

/**
 * The Clips tab: how a saved Instant Replay clip is framed and decorated.
 *
 * Nothing here changes what Instant Replay captures. Game, display, and audio remain whatever
 * the running buffer and the live mix already are; this scene only describes layout and the
 * overlay stack that gets burned into the saved file. Editing it must never restart the buffer,
 * which is why `clipStudio` is deliberately absent from Rust's `CAPTURE_KEYS`.
 */
export function ClipStudio() {
  const settings = useSettingsStore((state) => state.settings);
  const status = useRecordingStore((state) => state.status);
  const replay = useRecordingStore((state) => state.replay);
  const updateSetting = useSettingsStore((state) => state.update);
  const {
    scene,
    scenes,
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
    selectScene,
    addScene,
    renameScene,
    removeScene,
    copyScene,
    writeSettings,
    flush,
  } = useClipScene();
  const [camera, setCamera] = useState<CameraStatus>(IDLE_CAMERA_STATUS);
  const [propertiesId, setPropertiesId] = useState<string | null>(null);
  const { displays, error: displayError } = useDisplays();
  const levels = useStudioAudio();
  const propertiesSource = scene.sources.find((source) => source.id === propertiesId) ?? null;
  const quiet = status.active || replay.active || camera.rolling || camera.recording;

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void getCameraStatus().then((next) => {
      if (!cancelled && next) setCamera(next);
    });
    void listen<{ status: CameraStatus }>("camera-status", (event) => {
      if (event.payload?.status) setCamera(event.payload.status);
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [settings.webcam.enabled, settings.webcam.deviceId, replay.active, status.active]);

  // The preview timestamp renders local time; Rust's wall_clock_stamp works in UTC. Persist the
  // viewer's offset so the burned clock reads the same as what the Clips tab showed.
  const overlay = findSourceByType(scene, "replayrOverlay");
  const overlayId = overlay?.id;
  const overlayTz = overlay?.settings.tzOffsetMinutes;
  useEffect(() => {
    if (!overlayId) return;
    const current = tzOffsetMinutes();
    if (overlayTz === current) return;
    patchSource(overlayId, { settings: { tzOffsetMinutes: current } });
  }, [overlayId, overlayTz, patchSource]);

  async function addTypedSource(type: RecordingSourceType) {
    if (type === "image") {
      const selectedPath = await open({
        multiple: false,
        filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }],
      });
      if (typeof selectedPath !== "string" || !selectedPath) return;
      addSource("image", { settings: { path: selectedPath, opacity: 1 } });
      return;
    }
    if (type === "replayrOverlay") {
      // New clip overlays start with REC off: a clip is a highlight, not a session recording.
      addSource("replayrOverlay", {
        settings: { filter: "none", recIndicator: false, timestamp: false, tzOffsetMinutes: tzOffsetMinutes() },
      });
      return;
    }
    addSource(type);
  }

  function saveWebcamDevice(device: CameraDevice) {
    // Passes through the clip settings fence, which keeps device/quality and drops placement.
    void writeSettings("webcam", { ...settings.webcam, deviceId: device.id, name: device.name });
  }

  return (
    <>
      <SourceList
        scene={scene}
        scenes={scenes}
        selectedId={selectedId}
        levels={levels}
        settingsGain={{ mic: settings.micGain, desktop: settings.systemAudioGain, game: settings.gameAudioGain }}
        compositionLocked={false}
        onSelect={setSelectedId}
        onToggle={toggleSource}
        onLock={(id, locked) => patchSource(id, { locked })}
        onRemove={deleteSource}
        onAdd={(type) => void addTypedSource(type)}
        onReorder={commit}
        onSelectScene={(id) => {
          flush();
          selectScene(id);
        }}
        onCreateScene={addScene}
        onRenameScene={renameScene}
        onDuplicateScene={copyScene}
        onDeleteScene={removeScene}
        onProperties={(id) => {
          setSelectedId(id);
          setPropertiesId(id);
        }}
        onRenameSource={(id, name) => patchSource(id, { name })}
      />
      <RecordingPreview
        scene={scene}
        webcam={{ ...settings.webcam, enabled: Boolean(findSourceByType(scene, "webcam")?.enabled) }}
        // Clip visuals come from the scene's own overlay source. Passing the defaults here stops
        // `previewVisuals` from falling back to the Recordings studio's global recordingVisuals.
        visuals={DEFAULT_RECORDING_VISUALS}
        camera={camera}
        quiet={quiet}
        selectedId={selectedId}
        compositionLocked={false}
        onSelect={setSelectedId}
        onTransform={setTransform}
        onCrop={setCrop}
      />
      <SourceInspector
        source={selected}
        settings={settings}
        camera={camera}
        levels={levels}
        compositionLocked={false}
        composed={false}
        displays={displays}
        listError={displayError}
        recording={false}
        onSaveSetting={(key, value) => void writeSettings(key, value)}
        onPatch={patchSource}
        onToggle={toggleSource}
        onTransform={setTransform}
        onCrop={setCrop}
        onWebcamDevice={saveWebcamDevice}
      />
      <div className="record-dock">
        <AudioMixer
          scene={scene}
          settings={settings}
          selectedId={selectedId}
          levels={levels}
          readOnly
          mirrorOf={{
            mic: settings.micEnabled,
            game: settings.gameAudioEnabled,
            desktop: settings.systemAudioEnabled,
          }}
          onSelect={setSelectedId}
          onToggleMic={() => {}}
          onToggleGame={() => {}}
          onToggleDesktop={() => {}}
          onSave={() => {}}
          onProperties={(id) => {
            setSelectedId(id);
            setPropertiesId(id);
          }}
          onRemove={() => {}}
        />
        <section className="studio-panel studio-controls">
          <IrControlsCard
            settings={settings}
            onBeforeSaveClip={flush}
            onSave={(key, value) => {
              // IR enable and buffer length are genuinely global capture settings, so they go
              // straight to the store rather than through the clip scene's write fence.
              void updateSetting(key, value);
            }}
          />
        </section>
      </div>
      <footer className="studio-status">
        <span>Output: matches Instant Replay · Layout, burn on save</span>
        <span>{settings.fps} FPS</span>
        <span>Webcam: {findSourceByType(scene, "webcam")?.enabled ? "saved as a sidecar" : "off for clips"}</span>
        <IrEncoderDetails replay={replay} />
      </footer>
      {propertiesSource ? (
        <SourcePropertiesDialog
          source={propertiesSource}
          settings={settings}
          displays={displays}
          listError={displayError}
          recording={false}
          onMonitorId={(monitorId) => patchSource(propertiesSource.id, { settings: { monitorId } })}
          onSaveSetting={(key, value) => void writeSettings(key, value)}
          onClose={() => setPropertiesId(null)}
        />
      ) : null}
    </>
  );
}
