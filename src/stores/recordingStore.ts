import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import {
  getRecordingStatus,
  getReplayStatus,
  saveClip,
  saveScreenshot,
  startRecording,
  stopRecording,
} from "../services/tauri";
import { IDLE_RECORDING, IDLE_REPLAY, type RecordingStatus, type ReplayStatus } from "../types/recording";
import { invokeErrorMessage } from "../utils/format";
import { useToastStore } from "./toastStore";

interface RecordingState {
  status: RecordingStatus;
  replay: ReplayStatus;
  busy: boolean;
  libraryEpoch: number;
  initialize: () => Promise<void>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  saveClip: () => Promise<void>;
  screenshot: () => Promise<void>;
}

let listening = false;
let tick: number | null = null;
let replayClock: number | null = null;

function startedAtMs(startedAt: string | null): number | null {
  if (!startedAt) return null;
  const secs = Number(startedAt);
  if (Number.isFinite(secs) && secs > 1_000_000_000) return secs * 1000;
  const parsed = Date.parse(startedAt);
  return Number.isFinite(parsed) ? parsed : null;
}

function liveRecording(status: RecordingStatus): RecordingStatus {
  if (!status.active) return status;
  const start = startedAtMs(status.startedAt);
  if (start == null) return status;
  return { ...status, durationMs: Math.max(0, Date.now() - start) };
}

function applyReplay(replay: ReplayStatus): ReplayStatus {
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
    }, 1000);
  }
  if (!active && tick != null) {
    window.clearInterval(tick);
    tick = null;
  }
}

export const useRecordingStore = create<RecordingState>((set, get) => ({
  status: IDLE_RECORDING,
  replay: IDLE_REPLAY,
  busy: false,
  libraryEpoch: 0,
  initialize: async () => {
    try {
      const [status, replay] = await Promise.all([getRecordingStatus(), getReplayStatus()]);
      set({ status: liveRecording(status), replay: applyReplay(replay) });
      setClockTick(status.active || replay.active);
    } catch {
      set({ status: IDLE_RECORDING, replay: IDLE_REPLAY });
    }
    if (!listening) {
      listening = true;
      await listen<RecordingStatus>("recording-status", (event) => {
        const status = liveRecording(event.payload);
        set({ status, busy: false });
        setClockTick(status.active || useRecordingStore.getState().replay.active);
      });
      await listen<ReplayStatus>("replay-status", (event) => {
        const replay = applyReplay(event.payload);
        set({ replay });
        setClockTick(replay.active || useRecordingStore.getState().status.active);
      });
      await listen<{ path: string; kind: string }>("local-clip-saved", (event) => {
        const kind = event.payload.kind === "clip" ? "Clip saved" : event.payload.kind === "screenshot" ? "Screenshot saved" : "Recording saved";
        set((state) => ({ libraryEpoch: state.libraryEpoch + 1, status: { ...state.status, path: event.payload.path } }));
        useToastStore.getState().show(kind);
      });
      await listen<{ phase: string; message?: string; path?: string }>("clip-save", (event) => {
        if (event.payload.phase === "saving") {
          useToastStore.getState().show("Saving clip…");
        }
        if (event.payload.phase === "failed" && event.payload.message) {
          useToastStore.getState().show(event.payload.message);
        }
      });
    }
  },
  start: async () => {
    if (get().busy || get().status.active) return;
    set({ busy: true });
    try {
      const status = liveRecording(await startRecording());
      set({ status, busy: false });
      setClockTick(true);
    } catch (caught) {
      set({ busy: false });
      useToastStore.getState().show(invokeErrorMessage(caught, "Could not start recording"));
    }
  },
  stop: async () => {
    if (get().busy || !get().status.active) return;
    set({ busy: true });
    try {
      const status = await stopRecording();
      set({ status, busy: false, libraryEpoch: get().libraryEpoch + 1 });
      setClockTick(get().replay.active);
      useToastStore.getState().show("Saved recording");
    } catch (caught) {
      set({ busy: false });
      useToastStore.getState().show(invokeErrorMessage(caught, "Could not stop recording"));
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
      useToastStore.getState().show(invokeErrorMessage(caught, "Could not save screenshot"));
    }
  },
}));
