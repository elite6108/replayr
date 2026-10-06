import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { getCameraStatus } from "../../services/tauri";
import { useRecordingStore } from "../../stores/recordingStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { IDLE_CAMERA_STATUS, type CameraDevice, type CameraStatus } from "../../types/camera";
import type { AppSettings } from "../../types/settings";
import { canvasFromAspect } from "../../recording/previewCanvas";
import {
  createSource,
  findSourceByType,
  isAudioSource,
  isPrimaryCapture,
  nextOrder,
  visualsToOverlaySettings,
  type RecordingSourceType,
} from "../../recording/scene";
import { useDisplays } from "../../recording/display/useDisplays";
import { useRecordingScene } from "../../recording/useRecordingScene";
import { useStudioAudio } from "../../recording/useStudioAudio";
import { AudioMixer } from "./AudioMixer";
import { RecordControls } from "./RecordControls";
import { IrEncoderDetails } from "../common/IrEncoderDetails";
import { RecordingPreview } from "./RecordingPreview";
import { SourceInspector } from "./SourceInspector";
import { SourceList } from "./SourceList";
import { SourcePropertiesDialog } from "./SourcePropertiesDialog";

/** The Recordings tab: full-length legacy or composed recording. Behaviour is unchanged. */
export function RecordingStudio() {
  const settings = useSettingsStore((state) => state.settings);
  const status = useRecordingStore((state) => state.status);
  const replay = useRecordingStore((state) => state.replay);
  const startingComposed = useRecordingStore((state) => state.startingComposed);
  const compositionLocked = Boolean((status.active && status.composed) || startingComposed);
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
    beginGesture,
    applyGesture,
    commitGesture,
    cancelGesture,
    selectScene,
    addScene,
    renameScene,
    removeScene,
    copyScene,
    writeSettings,
    setOutputMode,
  } = useRecordingScene();
  const [camera, setCamera] = useState<CameraStatus>(IDLE_CAMERA_STATUS);
  const [propertiesId, setPropertiesId] = useState<string | null>(null);
  const [frameSize, setFrameSize] = useState({ w: 0, h: 0 });
  const dragging = useRef(false);
  const { displays, error: displayError } = useDisplays();
  const levels = useStudioAudio();
  const propertiesSource = scene.sources.find((source) => source.id === propertiesId) ?? null;
  const quiet = status.active || replay.active || camera.rolling || camera.recording;
  const negotiated = (status.outputWidth ?? 0) >= 2 && (status.outputHeight ?? 0) >= 2;
  const frameAspect = frameSize.w > 1 && frameSize.h > 1 ? frameSize.w / frameSize.h : 16 / 9;
  const logical = negotiated
    ? { width: status.outputWidth ?? 0, height: status.outputHeight ?? 0 }
    : canvasFromAspect(frameAspect, settings.resolution);
  const canvasAspect = logical.width > 0 && logical.height > 0 ? logical.width / logical.height : 16 / 9;
  const selectedAspect = (() => {
    if (!selected) return null;
    if (selected.type === "webcam" && settings.webcam.width > 1 && settings.webcam.height > 1) {
      return settings.webcam.width / settings.webcam.height;
    }
    if (isPrimaryCapture(selected.type) && frameSize.w > 1 && frameSize.h > 1) return frameSize.w / frameSize.h;
    return null;
  })();

  useEffect(() => {
    if (compositionLocked) commitGesture();
  }, [compositionLocked, commitGesture]);

  useEffect(() => {
    if (!compositionLocked || !propertiesSource || isAudioSource(propertiesSource.type)) return;
    setPropertiesId(null);
  }, [compositionLocked, propertiesSource]);

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
    <>
      <SourceList
        scene={scene}
        scenes={scenes}
        selectedId={selectedId}
        levels={levels}
        settingsGain={{ mic: settings.micGain, desktop: settings.systemAudioGain, game: settings.gameAudioGain }}
        compositionLocked={compositionLocked}
        legacySession={scene.outputMode !== "composed"}
        onSelect={setSelectedId}
        onToggle={(id, enabled) => {
          const source = scene.sources.find((item) => item.id === id);
          if (compositionLocked && !(source && isAudioSource(source.type))) return;
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
        onSelectScene={(id) => {
          if (compositionLocked) return;
          selectScene(id);
        }}
        onCreateScene={(name, template) => {
          if (compositionLocked) return;
          addScene(name, template);
        }}
        onRenameScene={(id, name) => {
          if (compositionLocked) return;
          renameScene(id, name);
        }}
        onDuplicateScene={(id) => {
          if (compositionLocked) return;
          copyScene(id);
        }}
        onDeleteScene={(id) => {
          if (compositionLocked) return;
          removeScene(id);
        }}
        onProperties={(id) => {
          const source = scene.sources.find((item) => item.id === id);
          if (compositionLocked && source && !isAudioSource(source.type)) return;
          setSelectedId(id);
          setPropertiesId(id);
        }}
        onRenameSource={(id, name) => {
          if (compositionLocked) return;
          patchSource(id, { name });
        }}
      />
      <RecordingPreview
        scene={scene}
        webcam={{ ...settings.webcam, enabled: Boolean(findSourceByType(scene, "webcam")?.enabled) }}
        visuals={settings.recordingVisuals}
        camera={camera}
        quiet={quiet}
        selectedId={selectedId}
        compositionLocked={compositionLocked}
        fitOutputCanvas
        outputWidth={status.outputWidth}
        outputHeight={status.outputHeight}
        onFrameSize={(width, height) => setFrameSize((prev) => (prev.w === width && prev.h === height ? prev : { w: width, h: height }))}
        onGestureStart={(id) => {
          dragging.current = true;
          beginGesture(id);
        }}
        onGestureEnd={() => {
          dragging.current = false;
          commitGesture();
        }}
        onGestureCancel={() => {
          dragging.current = false;
          cancelGesture();
        }}
        onSelect={setSelectedId}
        onTransform={(id, transform) => {
          if (compositionLocked) return;
          if (dragging.current) applyGesture(id, { transform });
          else setTransform(id, transform);
        }}
        onCrop={(id, crop) => {
          if (compositionLocked) return;
          if (dragging.current) applyGesture(id, { crop });
          else setCrop(id, crop);
        }}
      />
      <SourceInspector
        source={selected}
        settings={settings}
        camera={camera}
        levels={levels}
        compositionLocked={compositionLocked}
        describeFit
        canvasAspect={canvasAspect}
        sourceAspect={selectedAspect}
        composed={scene.outputMode === "composed"}
        displays={displays}
        listError={displayError}
        recording={status.active || startingComposed}
        onSaveSetting={(key, value) => {
          if (key === "microphoneId") {
            if (status.active || startingComposed) return;
            void writeSettings(key, value);
            return;
          }
          const liveAudio = key === "micGain" || key === "systemAudioGain" || key === "gameAudioGain";
          if (compositionLocked && !liveAudio) return;
          void writeSettings(key, value);
        }}
        onPatch={(id, patch) => {
          if (compositionLocked) return;
          patchSource(id, patch);
        }}
        onToggle={(id, enabled) => {
          const source = scene.sources.find((item) => item.id === id);
          if (compositionLocked && !isAudioSource(source?.type ?? "game")) return;
          toggleSource(id, enabled);
        }}
        onTransform={(id, transform) => {
          if (compositionLocked) return;
          setTransform(id, transform);
        }}
        onCrop={(id, crop) => {
          if (compositionLocked) return;
          setCrop(id, crop);
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
          onProperties={(id) => {
            const source = scene.sources.find((item) => item.id === id);
            if (compositionLocked && source && !isAudioSource(source.type)) return;
            setSelectedId(id);
            setPropertiesId(id);
          }}
          onRemove={(id) => {
            if (compositionLocked) return;
            deleteSource(id);
          }}
        />
        <RecordControls
          settings={settings}
          outputMode={scene.outputMode}
          onOutputMode={setOutputMode}
          onSave={(key, value) => void writeSettings(key, value)}
        />
      </div>
      <footer className="studio-status">
        <span>
          Requested: {outputSizeLabel(settings.resolution)} · {settings.fps} FPS
          {scene.outputMode === "composed" ? " · Composed" : " · Legacy"}
        </span>
        {scene.outputMode === "composed" && negotiated ? (
          <span>
            Recording: {status.outputWidth} × {status.outputHeight}
            {status.outputFps ? ` · ${status.outputFps} FPS` : ""}
            {status.outputFallback ? " · fallback" : ""}
          </span>
        ) : null}
        <span>Selected video quality: {qualityLabel(settings.bitrate)}</span>
        <IrEncoderDetails replay={replay} />
      </footer>
      {propertiesSource ? (
        <SourcePropertiesDialog
          source={propertiesSource}
          settings={settings}
          displays={displays}
          listError={displayError}
          recording={status.active || startingComposed}
          onMonitorId={(monitorId) => {
            if (status.active || startingComposed) return;
            patchSource(propertiesSource.id, { settings: { monitorId } });
          }}
          onSaveSetting={(key, value) => {
            if (key === "microphoneId" && (status.active || startingComposed)) return;
            void writeSettings(key, value);
          }}
          onClose={() => setPropertiesId(null)}
        />
      ) : null}
    </>
  );
}

export function outputSizeLabel(resolution: AppSettings["resolution"]) {
  if (resolution === "auto") return "Auto (≤1080p)";
  if (resolution === "1080p") return "1920 × 1080";
  if (resolution === "1440p") return "2560 × 1440";
  if (resolution === "4k") return "3840 × 2160";
  if (resolution === "720p") return "1280 × 720";
  return "Native";
}

export function qualityLabel(bitrate: AppSettings["bitrate"]) {
  if (bitrate === "low") return "Low Quality";
  if (bitrate === "high") return "Maximum";
  if (bitrate === "custom") return "Custom";
  return "High Quality";
}
