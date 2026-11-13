/**
 * Turn a parsed OBS scene collection into Replayr Recording scenes plus a report of what was
 * imported, approximated or skipped. Pure: devices, canvas and image sizes come in through
 * `ObsEnvironment`, so this runs the same in tests as in the app.
 */
import type { AudioDevice } from "../../types/audio";
import type { CameraDevice } from "../../types/camera";
import {
  clampTransform,
  createSource,
  isPrimaryCapture,
  MIN_CROP,
  newSceneId,
  sanitizeScene,
  sanitizeSceneName,
  type RecordingScene,
  type RecordingSource,
  type RecordingSourceType,
} from "../scene";
import { MAX_MICROPHONES } from "../sourceAudio";
import { MAX_DISPLAYS, MAX_WEBCAMS, MAX_WINDOWS, sanitizeCamera } from "../sourceVisual";
import { matchAudioDevice, matchCamera, type ObsMonitorInfo } from "./obsDevices";
import {
  childFrame,
  isFullUv,
  normalize,
  placeItem,
  placeOnCanvas,
  rootFrame,
  toCanvas,
  type Frame,
  type PlacementNote,
  type Size,
} from "./obsGeometry";
import { cleanString, settingBool, settingNumber, OBS_LIMITS, type ObsCollection, type ObsSceneItem, type ObsSource } from "./obsSchema";
import {
  audioRole,
  isContainer,
  isLocalImagePath,
  kindLabel,
  mapVisualSource,
  obsImagePath,
  type AudioRole,
} from "./obsSources";

export type ObsEnvironment = {
  canvas: Size;
  monitors: ObsMonitorInfo[];
  cameras: CameraDevice[];
  audioDevices: AudioDevice[];
  /** Probed sizes keyed by the exact OBS image path. `null` means missing or unreadable. */
  imageSizes: ReadonlyMap<string, Size | null>;
};

export type ObsReportStatus = "imported" | "approximated" | "skipped";

export type ObsReportEntry = {
  name: string;
  kind: string;
  status: ObsReportStatus;
  notes: string[];
};

export type ObsScenePlan = {
  name: string;
  scene: RecordingScene;
  entries: ObsReportEntry[];
};

export type ObsDevicePlan = {
  microphone: { id: string; name: string; gain: number } | null;
  desktopGain: number | null;
  webcam: CameraDevice | null;
  notes: string[];
};

export type ObsImportPlan = {
  collection: string;
  scenes: ObsScenePlan[];
  /** Desktop Audio and Mic/Aux devices that OBS plays in every scene. */
  globalEntries: ObsReportEntry[];
  devices: ObsDevicePlan;
};

/** Nested scenes and groups deeper than this are skipped. */
export const MAX_NESTING = 4;

/** Replayr's 1080p reference for text size. */
const TEXT_REFERENCE_HEIGHT = 1080;
const MIN_TEXT = 10;
const MAX_TEXT = 96;
const MIN_TRANSFORM = 0.06;

const PLACEMENT_NOTES: Record<PlacementNote, string> = {
  rotated: "Rotation is not supported, so it stays upright.",
  flipped: "Mirroring is not supported.",
  stretched: "Stretching is not supported, so it keeps its shape.",
};

type Leaf = {
  source: ObsSource;
  item: ObsSceneItem;
  frame: Frame;
  visible: boolean;
  inherited: PlacementNote[];
};

type SourceIndex = { byUuid: Map<string, ObsSource>; byName: Map<string, ObsSource> };

/** Every local image path the collection uses, so their sizes can be probed first. */
export function collectImagePaths(collection: ObsCollection): string[] {
  const paths = new Set<string>();
  for (const source of collection.sources) {
    if (source.kind !== "image_source") continue;
    const path = obsImagePath(source);
    if (path && isLocalImagePath(path)) paths.add(path);
  }
  return Array.from(paths).slice(0, 256);
}

export function buildObsImport(collection: ObsCollection, env: ObsEnvironment): ObsImportPlan {
  const index = indexSources(collection.sources);
  const scenes = collection.sceneOrder
    .map((name) => index.byName.get(name))
    .filter((source): source is ObsSource => Boolean(source && source.kind === "scene"))
    .map((scene) => buildScene(scene, collection, index, env));
  return {
    collection: collection.name,
    scenes,
    globalEntries: globalAudioEntries(collection.globalAudio),
    devices: planDevices(collection, env),
  };
}

function indexSources(sources: ObsSource[]): SourceIndex {
  const byUuid = new Map<string, ObsSource>();
  const byName = new Map<string, ObsSource>();
  for (const source of sources) {
    if (source.uuid && !byUuid.has(source.uuid)) byUuid.set(source.uuid, source);
    if (!byName.has(source.name)) byName.set(source.name, source);
  }
  return { byUuid, byName };
}

function resolveItem(item: ObsSceneItem, index: SourceIndex): ObsSource | undefined {
  return (item.sourceUuid ? index.byUuid.get(item.sourceUuid) : undefined) ?? index.byName.get(item.sourceName);
}

function displayName(source: ObsSource): string {
  return cleanString(source.name, 64) || kindLabel(source.kind);
}

function flatten(
  container: ObsSource,
  index: SourceIndex,
  env: ObsEnvironment,
  frame: Frame,
  state: { depth: number; visible: boolean; path: Set<string>; inherited: PlacementNote[] },
  leaves: Leaf[],
  entries: ObsReportEntry[],
): void {
  for (const item of container.items) {
    const source = resolveItem(item, index);
    if (!source) {
      entries.push({ name: cleanString(item.sourceName, 64) || "Source", kind: "Unknown", status: "skipped", notes: ["Its OBS source is missing from the file."] });
      continue;
    }
    if (!isContainer(source.kind)) {
      leaves.push({ source, item, frame, visible: state.visible && item.visible, inherited: state.inherited });
      continue;
    }
    const label = { name: displayName(source), kind: kindLabel(source.kind) };
    if (state.path.has(source.name)) {
      entries.push({ ...label, status: "skipped", notes: ["It contains itself."] });
      continue;
    }
    if (state.depth >= MAX_NESTING) {
      entries.push({ ...label, status: "skipped", notes: ["It is nested too deeply."] });
      continue;
    }
    const size = containerSize(source, env.canvas);
    const placed = placeItem(item, size);
    const child = placed ? childFrame(frame, placed.placement, size) : null;
    if (!placed || !child) {
      entries.push({ ...label, status: "skipped", notes: ["It is outside the canvas."] });
      continue;
    }
    flatten(
      source,
      index,
      env,
      child,
      {
        depth: state.depth + 1,
        visible: state.visible && item.visible,
        path: new Set([...state.path, source.name]),
        inherited: Array.from(new Set([...state.inherited, ...placed.notes])),
      },
      leaves,
      entries,
    );
  }
}

/** A nested scene is canvas-sized; a group stores its own size. */
function containerSize(source: ObsSource, canvas: Size): Size {
  if (source.kind !== "group") return canvas;
  const w = settingNumber(source.settings, "cx", 0, 0, OBS_LIMITS.coordinate);
  const h = settingNumber(source.settings, "cy", 0, 0, OBS_LIMITS.coordinate);
  return w >= 1 && h >= 1 ? { w, h } : canvas;
}

type VisualDraft = {
  type: RecordingSourceType;
  name: string;
  enabled: boolean;
  locked: boolean;
  transform: { x: number; y: number; w: number; h: number };
  crop: { x: number; y: number; w: number; h: number } | null;
  settings: Record<string, unknown>;
};

function buildScene(sceneSource: ObsSource, collection: ObsCollection, index: SourceIndex, env: ObsEnvironment): ObsScenePlan {
  const entries: ObsReportEntry[] = [];
  const leaves: Leaf[] = [];
  flatten(
    sceneSource,
    index,
    env,
    rootFrame(env.canvas),
    { depth: 0, visible: true, path: new Set([sceneSource.name]), inherited: [] },
    leaves,
    entries,
  );

  const visuals = pickVisuals(leaves, env, entries);
  const audio = pickAudio(leaves, collection, env, entries);

  let order = 1;
  const sources: RecordingSource[] = visuals.map((draft) =>
    createSource(draft.type, {
      order: order++,
      enabled: draft.enabled,
      locked: draft.locked,
      name: draft.name,
      transform: draft.transform,
      crop: draft.crop,
      settings: draft.settings,
    }),
  );
  if (audio.game) {
    sources.push(createSource("gameAudio", { order: order++, enabled: audio.game.enabled, name: audio.game.name, settings: audioSettings(audio.game) }));
  }
  if (audio.desktop) {
    sources.push(createSource("desktopAudio", { order: order++, enabled: audio.desktop.enabled, name: audio.desktop.name, settings: audioSettings(audio.desktop) }));
  }
  for (const mic of audio.mics) {
    sources.push(createSource("microphone", { order: order++, enabled: mic.enabled, name: mic.name, settings: audioSettings(mic) }));
  }

  const name = sanitizeSceneName(sceneSource.name, "OBS Scene");
  const scene = sanitizeScene({ id: newSceneId(), name, outputMode: "composed", sources }) ?? {
    id: newSceneId(),
    name,
    outputMode: "composed" as const,
    sources: [],
  };
  return { name, scene: { ...scene, outputMode: "composed" }, entries };
}

/** Bottom-to-top visual sources. One game sizes the recording. Extra displays, windows and webcams stay. */
function pickVisuals(leaves: Leaf[], env: ObsEnvironment, entries: ObsReportEntry[]): VisualDraft[] {
  const drafts: VisualDraft[] = [];
  const context = { canvas: env.canvas, monitors: env.monitors, imageSizes: env.imageSizes, cameras: env.cameras };
  const visualLeaves = leaves.filter((leaf) => !audioRole(leaf.source.kind));
  let games = 0;
  let displays = 0;
  let windows = 0;
  let webcams = 0;
  const seenCameras = new Set<string>();

  for (const leaf of visualLeaves) {
    const label = { name: displayName(leaf.source), kind: kindLabel(leaf.source.kind) };
    const mapping = mapVisualSource(leaf.source, context);
    if (!mapping.ok) {
      entries.push({ ...label, status: "skipped", notes: [mapping.reason] });
      continue;
    }
    if (mapping.type === "game" && !leaf.visible && visualLeaves.some((other) => other.source.kind === "game_capture" && other.visible)) {
      entries.push({ ...label, status: "skipped", notes: ["A scene records one game capture."] });
      continue;
    }
    if (mapping.type === "game" && games >= 1) {
      entries.push({ ...label, status: "skipped", notes: ["A scene records one game capture."] });
      continue;
    }
    if (mapping.type === "display" && displays >= MAX_DISPLAYS) {
      entries.push({ ...label, status: "skipped", notes: [`A scene can record up to ${MAX_DISPLAYS} displays.`] });
      continue;
    }
    if (mapping.type === "window" && windows >= MAX_WINDOWS) {
      entries.push({ ...label, status: "skipped", notes: [`A scene can record up to ${MAX_WINDOWS} windows.`] });
      continue;
    }
    if (mapping.type === "webcam") {
      const camera = sanitizeCamera(mapping.settings.camera);
      const device = camera?.deviceId.toLowerCase() ?? "";
      if (device && seenCameras.has(device)) {
        entries.push({ ...label, status: "skipped", notes: ["That camera is already in this scene."] });
        continue;
      }
      if (webcams >= MAX_WEBCAMS) {
        entries.push({ ...label, status: "skipped", notes: [`A scene can record up to ${MAX_WEBCAMS} webcams.`] });
        continue;
      }
      if (device) seenCameras.add(device);
    }

    const notes = [...mapping.notes];
    const placed = placeItem(leaf.item, mapping.size);
    const onCanvas = placed ? placeOnCanvas(leaf.frame, placed.placement) : null;
    if (!placed || !onCanvas) {
      entries.push({ ...label, status: "skipped", notes: ["It is outside the canvas."] });
      continue;
    }
    for (const note of new Set([...leaf.inherited, ...placed.notes])) notes.push(PLACEMENT_NOTES[note]);
    if (!mapping.sizeKnown && leaf.item.boundsType === 0 && mapping.type === "webcam") {
      notes.push("The camera size was not saved in OBS, so its size may differ slightly.");
    }

    let rect = onCanvas.rect;
    let crop: VisualDraft["crop"] = null;
    if (mapping.croppable) {
      if (!isFullUv(onCanvas.uv)) {
        crop = onCanvas.uv;
        if (crop.w < MIN_CROP || crop.h < MIN_CROP) notes.push("Cropped further than Replayr allows, so a little more shows.");
      }
    } else if (!isFullUv(onCanvas.uv)) {
      rect = toCanvas(leaf.frame, placed.placement.rect);
      notes.push("Part of it is off the canvas. Replayr keeps it whole and inside the frame.");
    }
    const normalized = normalize(rect, env.canvas);
    if (normalized.w < MIN_TRANSFORM || normalized.h < MIN_TRANSFORM) {
      notes.push("It is smaller than Replayr allows, so it was enlarged a little.");
    }
    const transform = clampTransform(normalized);

    const settings = { ...mapping.settings };
    if (mapping.type === "text" && mapping.fontPx) {
      const drawnHeight = toCanvas(leaf.frame, placed.placement.rect).h;
      const scale = drawnHeight / mapping.size.h;
      const size = Math.round(mapping.fontPx * scale * (TEXT_REFERENCE_HEIGHT / env.canvas.h));
      if (size > MAX_TEXT || size < MIN_TEXT) notes.push(`Text size was limited to ${size > MAX_TEXT ? MAX_TEXT : MIN_TEXT}.`);
      settings.size = Math.max(MIN_TEXT, Math.min(MAX_TEXT, size));
    }

    if (mapping.type === "game") games += 1;
    if (mapping.type === "display") displays += 1;
    if (mapping.type === "window") windows += 1;
    if (mapping.type === "webcam") webcams += 1;
    drafts.push({
      type: mapping.type,
      name: label.name,
      enabled: leaf.visible,
      locked: leaf.item.locked || (isPrimaryCapture(mapping.type) && isFullFrame(transform)),
      transform,
      crop,
      settings,
    });
    entries.push({ ...label, status: notes.length ? "approximated" : "imported", notes });
  }
  return drafts;
}

function isFullFrame(transform: { x: number; y: number; w: number; h: number }): boolean {
  return transform.x <= 1e-3 && transform.y <= 1e-3 && transform.w >= 1 - 1e-3 && transform.h >= 1 - 1e-3;
}

type AudioWanted = { name: string; enabled: boolean; gain: number; deviceId: string };

type PlannedAudio = { mics: AudioWanted[]; desktop: AudioWanted | null; game: AudioWanted | null };

/**
 * Up to four microphones, each with its own level and device. Desktop and game audio stay one
 * each, because the engine has one loopback and one game process capture.
 */
function pickAudio(leaves: Leaf[], collection: ObsCollection, env: ObsEnvironment, entries: ObsReportEntry[]): PlannedAudio {
  const planned: PlannedAudio = { mics: [], desktop: null, game: null };
  const take = (role: AudioRole, source: ObsSource, enabled: boolean, label: { name: string; kind: string } | null) => {
    const wanted = wantedFrom(source, env, role, enabled);
    if (role === "microphone") {
      if (planned.mics.length >= MAX_MICROPHONES) {
        if (label) entries.push({ ...label, status: "skipped", notes: [`Replayr records up to ${MAX_MICROPHONES} microphones per scene.`] });
        return;
      }
      if (planned.mics.some((mic) => mic.deviceId === wanted.deviceId)) {
        if (label) entries.push({ ...label, status: "skipped", notes: ["This microphone is already in the scene."] });
        return;
      }
      planned.mics.push(wanted);
      if (label) entries.push({ ...label, status: "imported", notes: wanted.note ? [wanted.note] : [] });
      return;
    }
    const slot = role === "desktopAudio" ? planned.desktop : planned.game;
    if (slot) {
      if (label) entries.push({ ...label, status: "skipped", notes: [`Replayr records one ${roleName(role).toLowerCase()} source per scene.`] });
      return;
    }
    if (role === "desktopAudio") planned.desktop = wanted;
    else planned.game = wanted;
    if (label) {
      const notes = role === "gameAudio" ? ["Game audio follows the game Replayr detects."] : [];
      if (wanted.note) notes.push(wanted.note);
      entries.push({ ...label, status: role === "gameAudio" || notes.length ? "approximated" : "imported", notes });
    }
  };
  for (const source of collection.globalAudio) {
    const role = audioRole(source.kind);
    if (role) take(role, source, !source.muted, null);
  }
  for (const leaf of leaves) {
    const role = audioRole(leaf.source.kind);
    if (role) {
      take(role, leaf.source, leaf.visible && !leaf.source.muted, { name: displayName(leaf.source), kind: kindLabel(leaf.source.kind) });
      continue;
    }
    if (leaf.source.kind === "game_capture" && settingBool(leaf.source.settings, "capture_audio", false) && !planned.game) {
      planned.game = { name: roleName("gameAudio"), enabled: leaf.visible && !leaf.source.muted, gain: clampGain(leaf.source.volume), deviceId: "default" };
    }
  }
  if (planned.mics[0]) planned.mics[0].name = roleName("microphone");
  if (planned.desktop) planned.desktop.name = roleName("desktopAudio");
  if (planned.game) planned.game.name = roleName("gameAudio");
  return planned;
}

function wantedFrom(source: ObsSource, env: ObsEnvironment, role: AudioRole, enabled: boolean): AudioWanted & { note?: string } {
  const direction = role === "microphone" ? "capture" : "render";
  const match = role === "gameAudio" ? { id: "default", name: "Default" } : matchAudioDevice(source.settings, env.audioDevices, direction);
  return {
    name: displayName(source),
    enabled,
    gain: clampGain(source.volume),
    deviceId: match?.id ?? "default",
    note: match ? undefined : `The device for "${displayName(source)}" is not connected, so the Windows default is used.`,
  };
}

function audioSettings(audio: AudioWanted): Record<string, unknown> {
  return { audio: { gain: audio.gain, deviceId: audio.deviceId } };
}

function roleName(role: AudioRole): string {
  if (role === "microphone") return "Microphone";
  if (role === "desktopAudio") return "Desktop Audio";
  return "Game Audio";
}

function globalAudioEntries(sources: ObsSource[]): ObsReportEntry[] {
  const seen = new Set<AudioRole>();
  let microphones = 0;
  return sources.map((source) => {
    const role = audioRole(source.kind);
    const label = { name: displayName(source), kind: kindLabel(source.kind) };
    if (!role) return { ...label, status: "skipped", notes: ["This OBS source type is not supported."] };
    if (role === "microphone") {
      microphones += 1;
      if (microphones > MAX_MICROPHONES) {
        return { ...label, status: "skipped", notes: [`Replayr records up to ${MAX_MICROPHONES} microphones per scene.`] };
      }
    } else if (seen.has(role)) {
      return { ...label, status: "skipped", notes: [`Replayr records one ${roleName(role).toLowerCase()} source per scene.`] };
    }
    seen.add(role);
    return { ...label, status: "imported", notes: ["Added to every imported scene."] };
  });
}

/** Devices and levels to adopt from OBS. Applied only when the user keeps that option on. */
function planDevices(collection: ObsCollection, env: ObsEnvironment): ObsDevicePlan {
  const notes: string[] = [];
  const all = [...collection.globalAudio, ...collection.sources];
  const mic = all.find((source) => audioRole(source.kind) === "microphone");
  const desktop = collection.globalAudio.find((source) => audioRole(source.kind) === "desktopAudio")
    ?? collection.sources.find((source) => audioRole(source.kind) === "desktopAudio");
  const camera = collection.sources.find((source) => source.kind === "dshow_input");

  let microphone: ObsDevicePlan["microphone"] = null;
  if (mic) {
    const match = matchAudioDevice(mic.settings, env.audioDevices, "capture");
    if (match) microphone = { ...match, gain: clampGain(mic.volume) };
    else notes.push(`The OBS microphone "${displayName(mic)}" is not connected, so your current microphone stays selected.`);
  }

  let webcam: CameraDevice | null = null;
  if (camera) {
    webcam = matchCamera(camera.settings, env.cameras);
    if (!webcam) notes.push(`The OBS camera "${displayName(camera)}" is not connected, so your current camera stays selected.`);
  }

  return {
    microphone,
    desktopGain: desktop ? clampGain(desktop.volume) : null,
    webcam,
    notes,
  };
}

function clampGain(volume: number): number {
  return Math.round(Math.max(0, Math.min(2, volume)) * 1000) / 1000;
}
