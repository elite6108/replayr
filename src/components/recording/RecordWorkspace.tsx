import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { getCameraStatus } from "../../services/tauri";
import { useRecordingStore } from "../../stores/recordingStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { IDLE_CAMERA_STATUS, type CameraDevice, type CameraStatus } from "../../types/camera";
import type { AppSettings } from "../../types/settings";
import {
  createSource,
  findSourceByType,
  nextOrder,
  visualsToOverlaySettings,
  type RecordingSourceType,
} from "../../recording/scene";
import { useRecordingScene } from "../../recording/useRecordingScene";
import { useStudioAudio } from "../../recording/useStudioAudio";
import { AudioMixer } from "./AudioMixer";
import { RecordControls } from "./RecordControls";
import { RecordingPreview } from "./RecordingPreview";
import { SourceInspector } from "./SourceInspector";
import { SourceList } from "./SourceList";

export function RecordWorkspace() {
  const settings = useSettingsStore((state) => state.settings);
  const status = useRecordingStore((state) => state.status);
  const replay = useRecordingStore((state) => state.replay);
  const startingComposed = useRecordingStore((state) => state.startingComposed);
  const compositionLocked = Boolean((status.active && status.composed) || startingComposed);
  const {
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
  } = useRecordingScene();
  const [camera, setCamera] = useState<CameraStatus>(IDLE_CAMERA_STATUS);
  const levels = useStudioAudio();
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

  async function addTypedSource(type: RecordingSourceType) {
    if (compositionLocked) return;
    if (type === "image") {
      const selectedPath = await open({
        multiple: false,
        filters: [{ name: "Images", extensions: scene.outputMode === "composed" ? ["png", "jpg", "jpeg"] : ["png", "jpg", "jpeg", "webp", "gif"] }],
      });
      if (typeof selectedPath !== "string" || !selectedPath) return;
      addSource("image", { settings: { path: selectedPath, opacity: 1 } });
      return;
    }
    if (type === "replayrOverlay") {
      addSource("replayrOverlay", { settings: visualsToOverlaySettings(settings.recordingVisuals) });
      return;
    }
    addSource(type);
  }

  function toggleAudio(type: "microphone" | "gameAudio" | "desktopAudio", enabled: boolean) {
    const existing = findSourceByType(scene, type);
    if (existing) {
      toggleSource(existing.id, enabled);
      return;
    }
    if (!enabled) return;
    const created = createSource(type, { order: nextOrder(scene.sources), enabled: true });
    commit({ ...scene, sources: [...scene.sources, created] });
  }

  function saveWebcamDevice(device: CameraDevice) {
    void writeSettings("webcam", { ...settings.webcam, deviceId: device.id, name: device.name });
  }

  return (
    <div className="record-studio">
      <header className="studio-page-head">
        <h1>Record</h1>
      </header>
      <div className="record-workspace">
        <SourceList
          scene={scene}
          selectedId={selectedId}
          levels={levels}
          settingsGain={{ mic: settings.micGain, game: settings.gameAudioGain }}
          compositionLocked={compositionLocked}
          onSelect={setSelectedId}
          onToggle={(id, enabled) => {
            if (compositionLocked) return;
            toggleSource(id, enabled);
          }}
          onLock={(id, locked) => {
            if (compositionLocked) return;
            patchSource(id, { locked });
          }}
          onRemove={(id) => {
            if (compositionLocked) return;
            deleteSource(id);
          }}
          onAdd={(type) => void addTypedSource(type)}
          onReorder={(next) => {
            if (compositionLocked) return;
            commit(next);
          }}
          onPreset={(preset) => {
            if (compositionLocked) return;
            applyPreset(preset);
          }}
        />
        <RecordingPreview
          scene={scene}
          webcam={{ ...settings.webcam, enabled: Boolean(findSourceByType(scene, "webcam")?.enabled) }}
          visuals={settings.recordingVisuals}
          camera={camera}
          quiet={quiet}
          selectedId={selectedId}
          outputLabel={outputSizeLabel(settings.resolution)}
          compositionLocked={compositionLocked}
          onSelect={setSelectedId}
          onTransform={(id, transform) => {
            if (compositionLocked) return;
            setTransform(id, transform);
          }}
        />
        <SourceInspector
          source={selected}
          settings={settings}
          camera={camera}
          levels={levels}
          compositionLocked={compositionLocked}
          composed={scene.outputMode === "composed"}
          onSaveSetting={(key, value) => {
            if (compositionLocked) return;
            void writeSettings(key, value);
          }}
          onPatch={(id, patch) => {
            if (compositionLocked) return;
            patchSource(id, patch);
          }}
          onToggle={(id, enabled) => {
            if (compositionLocked) return;
            toggleSource(id, enabled);
          }}
          onTransform={(id, transform) => {
            if (compositionLocked) return;
            setTransform(id, transform);
          }}
          onWebcamDevice={(device) => {
            if (compositionLocked) return;
            saveWebcamDevice(device);
          }}
        />
        <div className="record-dock">
          <AudioMixer
            scene={scene}
            settings={settings}
            selectedId={selectedId}
            levels={levels}
            onSelect={setSelectedId}
            onToggleMic={(enabled) => toggleAudio("microphone", enabled)}
            onToggleGame={(enabled) => toggleAudio("gameAudio", enabled)}
            onToggleDesktop={(enabled) => toggleAudio("desktopAudio", enabled)}
            onSave={(key, value) => void writeSettings(key, value)}
          />
          <RecordControls
            settings={settings}
            outputMode={scene.outputMode}
            onOutputMode={setOutputMode}
            onSave={(key, value) => void writeSettings(key, value)}
          />
        </div>
        <footer className="studio-status">
          <span>Output: {outputSizeLabel(settings.resolution)} · {scene.outputMode === "composed" ? "Composed" : "Legacy"}</span>
          <span>{settings.fps} FPS</span>
          <span>Video: {qualityLabel(settings.bitrate)}</span>
          <span className={`studio-ready${status.active ? " is-live" : ""}`}>
            <i />
            {status.active ? "Recording" : "Ready"}
          </span>
        </footer>
      </div>
    </div>
  );
}

function outputSizeLabel(resolution: AppSettings["resolution"]) {
  if (resolution === "1080p") return "1920 × 1080";
  if (resolution === "720p") return "1280 × 720";
  return "Native";
}

function qualityLabel(bitrate: AppSettings["bitrate"]) {
  if (bitrate === "low") return "Low Quality";
  if (bitrate === "high") return "Maximum";
  if (bitrate === "custom") return "Custom";
  return "High Quality";
}
