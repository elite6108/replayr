import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { composedStartBlocker, sessionWebcamLayoutFromScene, snapshotRecordingComposition } from "../recording/composition";
import { loadActiveScene } from "../recording/sceneLibrary";
import {
  getRecordingStatus,
  getReplayStatus,
  saveClip,
  saveScreenshot,
  setRecordScene,
  startComposedRecording,
  stopComposedRecording,
  stopRecording,
} from "../services/tauri";
import { IDLE_RECORDING, IDLE_REPLAY, type RecordingStatus, type ReplayStatus } from "../types/recording";
import { reportDesktopError } from "../services/telemetry";
import { invokeErrorMessage } from "../utils/format";
import { useSettingsStore } from "./settingsStore";
import { useToastStore } from "./toastStore";

interface RecordingState {
  status: RecordingStatus;
  replay: ReplayStatus;
  busy: boolean;
  startingComposed: boolean;
  libraryEpoch: number;
  initialize: () => Promise<void>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  saveClip: () => Promise<void>;
  screenshot: () => Promise<void>;
}

let tick: number | null = null;
const RECORDING_LISTEN_KEY = "__replayRecordingListeners";

async function attachRecordingListeners() {
  const slot = window as unknown as Record<string, Array<() => void> | undefined>;
  for (const off of slot[RECORDING_LISTEN_KEY] ?? []) off();
  slot[RECORDING_LISTEN_KEY] = [
    await listen<RecordingStatus>("recording-status", (event) => {
      const status = liveRecording(event.payload);
      noteRecordingError(status.active ? null : status.error, status.errorDetail);
      useRecordingStore.setState({ status, busy: false });
      setClockTick(status.active || useRecordingStore.getState().replay.active);
    }),
    await listen<ReplayStatus>("replay-status", (event) => {
      const replay = applyReplay(event.payload);
      useRecordingStore.setState({ replay });
      setClockTick(replay.active || useRecordingStore.getState().status.active);
    }),
    await listen("replay-bitrate-applied", () => {
      useToastStore.getState().show("Bitrate applied. Instant Replay restarted; the old buffer was cleared. Saved clips are unchanged.");
    }),
    await listen<{ path: string; kind: string }>("local-clip-saved", (event) => {
      const kind =
        event.payload.kind === "clip"
          ? "Clip saved"
          : event.payload.kind === "screenshot"
            ? "Screenshot saved"
            : "Recording saved";
      useRecordingStore.setState((state) => ({
        libraryEpoch: state.libraryEpoch + 1,
        status: { ...state.status, path: event.payload.path },
      }));
      useToastStore.getState().show(kind);
    }),
    await listen<{ phase: string; message?: string; path?: string }>("clip-save", (event) => {
      if (event.payload.phase === "saving") {
        useToastStore.getState().show("Saving clip…");
      }
      if (event.payload.phase === "failed" && event.payload.message) {
        useToastStore.getState().show(event.payload.message);
        reportDesktopError({
          message: event.payload.message,
          path: "#/record",
          always: true,
        });
      }
    }),
  ];
}

let replayClock: number | null = null;
let replayRevision = 0;
let encoderPollInFlight = false;

async function refreshEncoderStatus() {
  if (encoderPollInFlight || !useRecordingStore.getState().replay.active) return;
  encoderPollInFlight = true;
  const revision = replayRevision;
  try {
    const fresh = await getReplayStatus();
    const current = useRecordingStore.getState().replay;
    // Never overwrite a newer stop/start/settings event with an older poll.
    // Only diagnostics are polled; save progress and the buffer clock stay
    // owned by the existing events and timer.
    if (revision === replayRevision && fresh.active && current.active) {
      useRecordingStore.setState({ replay: {
        ...current, encoder: fresh.encoder, settingsPending: fresh.settingsPending,
        bitrateRestartPending: fresh.bitrateRestartPending, restarting: fresh.restarting,
      } });
    }
  } catch {
    // A transient status failure must not interrupt recording or clip saving.
  } finally {
    encoderPollInFlight = false;
  }
}

function startedAtMs(startedAt: string | null): number | null {
  if (!startedAt) return null;
  const secs = Number(startedAt);
  if (Number.isFinite(secs) && secs > 1_000_000_000) return secs * 1000;
  const parsed = Date.parse(startedAt);
  return Number.isFinite(parsed) ? parsed : null;
}

let lastRecordingError = "";

function noteRecordingError(message: string | null | undefined, detail?: string | null) {
  if (!message) {
    lastRecordingError = "";
    return;
  }
  if (message === lastRecordingError) return;
  lastRecordingError = message;
  useToastStore.getState().show(message);
  reportDesktopError({
    message,
    stack: detail || undefined,
    path: "#/record",
    always: true,
  });
}

function liveRecording(status: RecordingStatus): RecordingStatus {
  if (!status.active) return status;
  const start = startedAtMs(status.startedAt);
  if (start == null) return status;
  return { ...status, durationMs: Math.max(0, Date.now() - start) };
}

function applyReplay(replay: ReplayStatus): ReplayStatus {
  replayRevision += 1;
  if (!replay.active) {
    replayClock = null;
    return replay;
  }
  replayClock = Date.now() - Math.max(0, replay.bufferedMs);
  return replay;
}

function tickReplay(replay: ReplayStatus): ReplayStatus {
  if (!replay.active || replayClock == null) return replay;
  return {
    ...replay,
    bufferedMs: Math.min(replay.durationMs, Math.max(0, Date.now() - replayClock)),
  };
}

function setClockTick(active: boolean) {
  if (active && tick == null) {
    tick = window.setInterval(() => {
      const { status, replay } = useRecordingStore.getState();
      useRecordingStore.setState({
        status: liveRecording(status),
        replay: tickReplay(replay),
      });
      void refreshEncoderStatus();
    }, 1000);
  }
  if (!active && tick != null) {
    window.clearInterval(tick);
    tick = null;
  }
}

let recordSceneTimer: number | null = null;
let recordSceneSubscribed = false;

/** Sends the active Recordings scene to Rust so the toggle hotkey and tray record the same layout. */
export function scheduleRecordScenePush(delayMs = 400) {
  if (recordSceneTimer != null) window.clearTimeout(recordSceneTimer);
  recordSceneTimer = window.setTimeout(() => {
    recordSceneTimer = null;
    const settings = useSettingsStore.getState().settings;
    const scene = loadActiveScene(settings);
    void setRecordScene(
      snapshotRecordingComposition(scene, settings, settings.webcam.mirrorRecording),
      sessionWebcamLayoutFromScene(scene),
    ).catch(() => undefined);
  }, delayMs);
}

export const useRecordingStore = create<RecordingState>((set, get) => ({
  status: IDLE_RECORDING,
  replay: IDLE_REPLAY,
  busy: false,
  startingComposed: false,
  libraryEpoch: 0,
  initialize: async () => {
    try {
      const [status, replay] = await Promise.all([getRecordingStatus(), getReplayStatus()]);
      set({ status: liveRecording(status), replay: applyReplay(replay) });
      setClockTick(status.active || replay.active);
    } catch {
      set({ status: IDLE_RECORDING, replay: IDLE_REPLAY });
    }
    await attachRecordingListeners();
    if (!recordSceneSubscribed) {
      recordSceneSubscribed = true;
      useSettingsStore.subscribe((state, previous) => {
        if (state.settings !== previous.settings) scheduleRecordScenePush();
      });
    }
    scheduleRecordScenePush(0);
  },
  start: async () => {
    if (get().busy || get().status.active) return;
    const settings = useSettingsStore.getState().settings;
    const scene = loadActiveScene(settings);
    const blocked = composedStartBlocker(scene, settings);
    if (blocked) {
      useToastStore.getState().show(blocked);
      return;
    }
    const webcamLayout = sessionWebcamLayoutFromScene(scene);
    set({ busy: true, startingComposed: true });
    try {
      const status = liveRecording(
        await startComposedRecording(
          snapshotRecordingComposition(scene, settings, settings.webcam.mirrorRecording),
          webcamLayout,
        ),
      );
      set({ status, busy: false, startingComposed: false });
      setClockTick(true);
    } catch (caught) {
      set({ busy: false, startingComposed: false });
      const message = invokeErrorMessage(caught, "Could not start recording");
      useToastStore.getState().show(message);
      reportDesktopError({ message, path: "#/record", always: true });
    }
  },
  stop: async () => {
    const { status, busy, startingComposed } = get();
    if (busy && !startingComposed && !status.active) return;
    if (!status.active && !startingComposed) return;
    const useComposed = status.composed || startingComposed;
    set({ busy: true, startingComposed: false });
    try {
      const next = useComposed ? await stopComposedRecording() : await stopRecording();
      set({ status: next, busy: false, libraryEpoch: get().libraryEpoch + 1 });
      setClockTick(get().replay.active);
      if (!next.active) noteRecordingError(next.error, next.errorDetail);
    } catch (caught) {
      set({ busy: false, startingComposed: false });
      noteRecordingError(invokeErrorMessage(caught, "Could not stop recording"));
    }
  },
  saveClip: async () => {
    if (get().busy || get().replay.saving) return;
    set({ busy: true });
    try {
      await saveClip();
      set({ busy: false, libraryEpoch: get().libraryEpoch + 1 });
    } catch (caught) {
      set({ busy: false });
      const message = invokeErrorMessage(caught, "Could not save clip");
      useToastStore.getState().show(message);
      reportDesktopError({ message, path: "#/record", always: true });
      void import("../services/analytics").then(({ trackClipSaveFailed }) => trackClipSaveFailed(message));
    }
  },
  screenshot: async () => {
    if (get().busy) return;
    set({ busy: true });
    try {
      const path = await saveScreenshot();
      set({ busy: false, libraryEpoch: get().libraryEpoch + 1 });
      useToastStore.getState().show(`Saved screenshot · ${path}`);
    } catch (caught) {
      set({ busy: false });
      const message = invokeErrorMessage(caught, "Could not save screenshot");
      useToastStore.getState().show(message);
      reportDesktopError({ message, path: "#/record", always: true });
    }
  },
}));
