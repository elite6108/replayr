import { useContext, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useNavigate } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { getCameraStatus } from "../../services/tauri";
import { scheduleRecordScenePush, useRecordingStore } from "../../stores/recordingStore";
import { useDetectionStore } from "../../stores/detectionStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useToastStore } from "../../stores/toastStore";
import { IDLE_CAMERA_STATUS, type CameraDevice, type CameraStatus } from "../../types/camera";
import type { AppSettings } from "../../types/settings";
import { canvasFromAspect } from "../../recording/previewCanvas";
import type { ObsDevicePlan } from "../../recording/obs/obsImport";
import {
  createSource,
  findSourceByType,
  isAudioSource,
  isPrimaryCapture,
  nextOrder,
  visualsToOverlaySettings,
  type RecordingScene,
  type RecordingSourceType,
} from "../../recording/scene";
import { MAX_SCENE_LIBRARY } from "../../recording/sceneLibrary";
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
import { VideoSettingsDialog } from "./VideoSettingsDialog";
import { ImportObsDialog } from "./ImportObsDialog";
import { formatBytes } from "../../utils/format";
import { displayFps, qualityLabel } from "../../utils/qualityLabels";
import { IconFolder, IconGames } from "../icons";
import { StudioTabActions } from "./StudioShell";
import { RECORDABLE_IMAGE_EXTENSIONS } from "../../recording/composition";

const CAPTURE_COLUMNS = ["scenes", "sources", "mixer", "inspector", "controls"] as const;
type CaptureColumnId = (typeof CAPTURE_COLUMNS)[number];
const CAPTURE_COLUMNS_KEY = "replay.captureColumns";

function readCaptureColumns(): CaptureColumnId[] {
  try {
    const raw = JSON.parse(window.localStorage.getItem(CAPTURE_COLUMNS_KEY) || "null");
    if (!Array.isArray(raw)) return [...CAPTURE_COLUMNS];
    const known = raw.filter((id): id is CaptureColumnId => (CAPTURE_COLUMNS as readonly string[]).includes(id));
    const missing = CAPTURE_COLUMNS.filter((id) => !known.includes(id));
    return [...known, ...missing];
  } catch {
    return [...CAPTURE_COLUMNS];
  }
}

function reorderCaptureColumn(order: CaptureColumnId[], id: CaptureColumnId, over: CaptureColumnId): CaptureColumnId[] {
  const from = order.indexOf(id);
  const to = order.indexOf(over);
  if (from < 0 || to < 0 || from === to) return order;
  const next = [...order];
  next.splice(from, 1);
  next.splice(to, 0, id);
  return next;
}

/** The Recordings tab: full-length recording of the scene layout into one MP4. */
export function RecordingStudio() {
  const navigate = useNavigate();
  const showClips = useContext(StudioTabActions).showClips;
  const detected = useDetectionStore((state) => state.snapshot);
  const catalog = useDetectionStore((state) => state.catalog);
  const settings = useSettingsStore((state) => state.settings);
  const status = useRecordingStore((state) => state.status);
  const replay = useRecordingStore((state) => state.replay);
  const startingComposed = useRecordingStore((state) => state.startingComposed);
  const compositionLocked = Boolean(status.active || startingComposed);
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
    importScenes,
    renameScene,
    removeScene,
    moveScene,
    copyScene,
    writeSettings,
    saveSourceAudio,
  } = useRecordingScene();
  const showToast = useToastStore((state) => state.show);
  const [camera, setCamera] = useState<CameraStatus>(IDLE_CAMERA_STATUS);
  const [propertiesId, setPropertiesId] = useState<string | null>(null);
  const [videoSettingsId, setVideoSettingsId] = useState<string | null>(null);
  const [obsImportOpen, setObsImportOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [columns, setColumns] = useState<CaptureColumnId[]>(readCaptureColumns);
  const [draggingColumn, setDraggingColumn] = useState<CaptureColumnId | null>(null);
  const [frameSize, setFrameSize] = useState({ w: 0, h: 0 });
  const dragging = useRef(false);
  const columnsRef = useRef(columns);
  columnsRef.current = columns;
  const dragColumn = useRef<CaptureColumnId | null>(null);
  const pushSceneNow = useRef(false);
  const { displays, error: displayError, refresh: refreshDisplays } = useDisplays();
  const levels = useStudioAudio();
  const propertiesSource = scene.sources.find((source) => source.id === propertiesId) ?? null;
  const videoSettingsSource = scene.sources.find((source) => source.id === videoSettingsId) ?? null;
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
    scheduleRecordScenePush(pushSceneNow.current ? 0 : 400);
    pushSceneNow.current = false;
  }, [scene]);

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
        filters: [{ name: "PNG or JPEG", extensions: [...RECORDABLE_IMAGE_EXTENSIONS] }],
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

  async function importFromObs(incoming: RecordingScene[], devices: ObsDevicePlan | null) {
    if (compositionLocked || !incoming.length) return;
    if (scenes.length >= MAX_SCENE_LIBRARY) {
      showToast(`You can keep up to ${MAX_SCENE_LIBRARY} scenes. Delete some to import more.`);
      return;
    }
    setObsImportOpen(false);
    // Devices go first and are awaited so the webcam write settles before the new scene syncs its own flags.
    if (devices) await applyObsDevices(devices);
    const recording = useRecordingStore.getState();
    if (recording.status.active || recording.startingComposed) {
      showToast("Stop recording to import scenes.");
      return;
    }
    const { added, dropped } = importScenes(incoming);
    if (!added) return;
    const noun = added === 1 ? "scene" : "scenes";
    showToast(
      dropped
        ? `Imported ${added} ${noun} from OBS. ${dropped} did not fit in the ${MAX_SCENE_LIBRARY}-scene limit.`
        : `Imported ${added} ${noun} from OBS.`,
    );
  }

  async function applyObsDevices(devices: ObsDevicePlan) {
    const current = useSettingsStore.getState().settings;
    if (devices.microphone) {
      if (devices.microphone.id !== current.microphoneId) await writeSettings("microphoneId", devices.microphone.id);
      if (devices.microphone.gain !== current.micGain) await writeSettings("micGain", devices.microphone.gain);
    }
    if (devices.desktopGain !== null && devices.desktopGain !== current.systemAudioGain) {
      await writeSettings("systemAudioGain", devices.desktopGain);
    }
    if (devices.webcam && devices.webcam.id !== current.webcam.deviceId) {
      const webcam = useSettingsStore.getState().settings.webcam;
      await writeSettings("webcam", { ...webcam, deviceId: devices.webcam.id, name: devices.webcam.name });
    }
  }

  function openInspector(id: string) {
    setSelectedId(id);
    setInspectorOpen(true);
  }

  function onDockPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest("button, input, select, textarea, a, label")) return;
    const head = target.closest(".studio-block-head");
    if (!head || !event.currentTarget.contains(head)) return;
    const id = head.closest("[data-capture-column]")?.getAttribute("data-capture-column");
    if (!id || !(CAPTURE_COLUMNS as readonly string[]).includes(id)) return;
    dragColumn.current = id as CaptureColumnId;
    setDraggingColumn(id as CaptureColumnId);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onDockPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const id = dragColumn.current;
    if (!id) return;
    const next = document.elementFromPoint(event.clientX, event.clientY)?.closest("[data-capture-column]")?.getAttribute("data-capture-column");
    if (!next || next === id || !(CAPTURE_COLUMNS as readonly string[]).includes(next)) return;
    setColumns((current) => {
      const reordered = reorderCaptureColumn(current, id, next as CaptureColumnId);
      columnsRef.current = reordered;
      return reordered;
    });
  }

  function onDockPointerUp() {
    if (!dragColumn.current) return;
    dragColumn.current = null;
    setDraggingColumn(null);
    window.localStorage.setItem(CAPTURE_COLUMNS_KEY, JSON.stringify(columnsRef.current));
  }

  function sourceColumn(part: "scenes" | "sources") {
    return (
      <SourceList
        part={part}
        scene={scene}
        scenes={scenes}
        presentation="list"
        selectedId={selectedId}
        levels={levels}
        settingsGain={{ mic: settings.micGain, desktop: settings.systemAudioGain, game: settings.gameAudioGain }}
        compositionLocked={compositionLocked}
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
        onMoveScene={(id, direction) => {
          if (compositionLocked) return;
          moveScene(id, direction);
        }}
        onImportScenes={() => {
          if (compositionLocked) return;
          setObsImportOpen(true);
        }}
        onProperties={(id) => {
          const source = scene.sources.find((item) => item.id === id);
          if (compositionLocked && source && !isAudioSource(source.type)) return;
          setSelectedId(id);
          setPropertiesId(id);
        }}
        onInspect={part === "sources" ? openInspector : undefined}
        onVideoSettings={(id) => {
          setSelectedId(id);
          setVideoSettingsId(id);
        }}
        onRenameSource={(id, name) => {
          if (compositionLocked) return;
          patchSource(id, { name });
        }}
      />
    );
  }

  const detectedGame = catalog.find((game) => game.slug === detected.slug);
  const savePlace = friendlySavePlace(settings.saveLocation || status.path || "");
  const quality = qualityLabel(settings.bitrate);

  return (
    <>
      <header className="capture-head">
        <div className="capture-head-title">
          <h1>Capture</h1>
          <div className="capture-head-status">
            <IconGames size={14} />
            <span>{scene.name}</span>
            <i className="capture-head-dot" />
            <span>{status.error ? "Not saved" : "All changes saved"}</span>
            <button type="button" className="capture-clips" onClick={showClips}>
              Clips
            </button>
          </div>
        </div>
        <div className="capture-head-actions">
          {detected.name ? (
            <span className="capture-game">
              {detectedGame?.iconUrl ? <img src={detectedGame.iconUrl} alt="" /> : <IconGames size={16} />}
              <span>{detected.name}</span>
              <i className={detected.focused ? "is-live" : ""} />
            </span>
          ) : null}
          <button type="button" className="capture-open" onClick={() => navigate("/library")}>
            <IconFolder size={14} />
            Open recordings
          </button>
        </div>
      </header>
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
        displays={displays}
      />
      <div
        className="record-dock"
        onPointerDown={onDockPointerDown}
        onPointerMove={onDockPointerMove}
        onPointerUp={onDockPointerUp}
        onPointerCancel={onDockPointerUp}
      >
        {columns.map((id) => {
          if (id === "inspector" && !inspectorOpen) return null;
          return (
            <div
              key={id}
              className={`capture-column is-${id}${draggingColumn === id ? " is-dragging" : ""}`}
              data-capture-column={id}
            >
              {id === "scenes" ? sourceColumn("scenes") : null}
              {id === "sources" ? sourceColumn("sources") : null}
              {id === "mixer" ? (
        <AudioMixer
          scene={scene}
          settings={settings}
          selectedId={selectedId}
          levels={levels}
          extraPeaks={levels.extraPeaks}
          onSelect={setSelectedId}
          onToggleMic={(enabled) => toggleAudio("microphone", enabled)}
          onSetEnabled={(id, enabled) => {
            const source = scene.sources.find((item) => item.id === id);
            if (compositionLocked && !isAudioSource(source?.type ?? "game")) return;
            toggleSource(id, enabled);
          }}
          onToggleGame={(enabled) => toggleAudio("gameAudio", enabled)}
          onToggleDesktop={(enabled) => toggleAudio("desktopAudio", enabled)}
          onSave={(key, value) => void writeSettings(key, value)}
          onSourceAudio={saveSourceAudio}
          onProperties={(id) => {
            const source = scene.sources.find((item) => item.id === id);
            if (compositionLocked && source && !isAudioSource(source.type)) return;
            setSelectedId(id);
            setPropertiesId(id);
          }}
          onInspect={openInspector}
          onRemove={(id) => {
            if (compositionLocked) return;
            deleteSource(id);
          }}
        />
              ) : null}
              {id === "inspector" ? (
        <SourceInspector
          source={selected}
          settings={settings}
          camera={camera}
          levels={levels}
          compositionLocked={compositionLocked}
          describeFit
          canvasAspect={canvasAspect}
          sourceAspect={selectedAspect}
          composed
          displays={displays}
          onRefreshDisplays={refreshDisplays}
          listError={displayError}
          recording={status.active || startingComposed}
          sources={scene.sources}
          onSourceAudio={saveSourceAudio}
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
            if (patch.settings && Object.prototype.hasOwnProperty.call(patch.settings, "monitorId")) pushSceneNow.current = true;
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
          onClose={() => setInspectorOpen(false)}
        />
              ) : null}
              {id === "controls" ? (
        <RecordControls
          settings={settings}
          onSave={(key, value) => void writeSettings(key, value)}
        />
              ) : null}
            </div>
          );
        })}
      </div>
      <footer className="studio-status">
        <span className={`capture-ready${status.error ? " is-error" : ""}`}>
          <i />
          {status.error ? "Capture issue" : status.active ? "Recording" : "Capture ready"}
        </span>
        <span className="capture-status-rule" />
        <span>
          {outputSizeLabel(settings.resolution)} · {displayFps(settings.fps)} FPS · {quality === "Custom" ? "Custom" : `${quality} quality`}
        </span>
        {negotiated ? (
          <span>
            Recording {status.outputWidth} × {status.outputHeight}
            {status.outputFps ? ` · ${status.outputFps} FPS` : ""}
            {status.outputFallback ? " · fallback" : ""}
          </span>
        ) : null}
        <span className="capture-status-note">Replay saves clips without stopping your recording.</span>
        {replay.diskFreeBytes != null ? <span>{formatBytes(replay.diskFreeBytes)} free</span> : null}
        <span>{savePlace}</span>
        {replay.active || replay.restarting || replay.error ? (
          <details className="capture-encoder">
            <summary>Encoder</summary>
            <IrEncoderDetails replay={replay} />
          </details>
        ) : null}
      </footer>
      {propertiesSource ? (
        <SourcePropertiesDialog
          source={propertiesSource}
          settings={settings}
          displays={displays}
          listError={displayError}
          recording={status.active || startingComposed}
          strictDisplay
          onRefreshDisplays={refreshDisplays}
          onMonitorId={(monitorId) => {
            if (status.active || startingComposed) return;
            pushSceneNow.current = true;
            patchSource(propertiesSource.id, { settings: { monitorId } });
          }}
          sources={scene.sources}
          onSourceAudio={(audio) => saveSourceAudio(propertiesSource.id, audio)}
          onSaveSetting={(key, value) => {
            if ((key === "microphoneId" || key === "audioOutputId") && (status.active || startingComposed)) return;
            void writeSettings(key, value);
          }}
          onClose={() => setPropertiesId(null)}
        />
      ) : null}
      {videoSettingsSource ? (
        <VideoSettingsDialog
          source={videoSettingsSource}
          settings={settings}
          composed={scene.outputMode === "composed"}
          locked={compositionLocked}
          onPicture={(picture) => {
            if (compositionLocked) return;
            patchSource(videoSettingsSource.id, { settings: { picture } });
          }}
          onSaveSetting={(key, value) => {
            if (compositionLocked && key === "webcam") {
              const current = settings.webcam;
              const next = value as AppSettings["webcam"];
              if (next.width !== current.width || next.height !== current.height || next.fps !== current.fps) return;
            }
            void writeSettings(key, value);
          }}
          onClose={() => setVideoSettingsId(null)}
        />
      ) : null}
      {obsImportOpen ? (
        <ImportObsDialog
          existingCount={scenes.length}
          locked={compositionLocked}
          onImport={(incoming, devices) => void importFromObs(incoming, devices)}
          onClose={() => setObsImportOpen(false)}
        />
      ) : null}
    </>
  );
}

function friendlySavePlace(value: string) {
  const parts = value.trim().split(/[\\/]+/).filter(Boolean);
  if (parts.length === 0) return "Videos / Replayr";
  return parts.slice(-2).join(" / ");
}

export function outputSizeLabel(resolution: AppSettings["resolution"]) {
  if (resolution === "auto") return "Auto (≤1080p)";
  if (resolution === "1080p") return "1920 × 1080";
  if (resolution === "1440p") return "2560 × 1440";
  if (resolution === "4k") return "3840 × 2160";
  if (resolution === "720p") return "1280 × 720";
  return "Native";
}
