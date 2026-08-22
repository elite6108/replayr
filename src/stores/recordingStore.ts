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

function setTick(active: boolean, refresh: () => void) {
  if (active && tick == null) {
    tick = window.setInterval(refresh, 500);
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
      set({ status, replay });
      setTick(status.active || replay.active, () => {
        void Promise.all([getRecordingStatus(), getReplayStatus()]).then(([status, replay]) => set({ status, replay }));
      });
    } catch {
      set({ status: IDLE_RECORDING, replay: IDLE_REPLAY });
    }
    if (!listening) {
      listening = true;
      await listen<RecordingStatus>("recording-status", (event) => {
        set({ status: event.payload, busy: false });
        const replayActive = useRecordingStore.getState().replay.active;
        setTick(event.payload.active || replayActive, () => {
          void Promise.all([getRecordingStatus(), getReplayStatus()]).then(([status, replay]) => set({ status, replay }));
        });
      });
      await listen<ReplayStatus>("replay-status", (event) => {
        set({ replay: event.payload });
        const recordingActive = useRecordingStore.getState().status.active;
        setTick(event.payload.active || recordingActive, () => {
          void Promise.all([getRecordingStatus(), getReplayStatus()]).then(([status, replay]) => set({ status, replay }));
        });
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
      const status = await startRecording();
      set({ status, busy: false });
      setTick(true, () => {
        void Promise.all([getRecordingStatus(), getReplayStatus()]).then(([status, replay]) => set({ status, replay }));
      });
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
      setTick(get().replay.active, () => {
        void Promise.all([getRecordingStatus(), getReplayStatus()]).then(([status, replay]) => set({ status, replay }));
      });
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
      useToastStore.getState().show(invokeErrorMessage(caught, "Could not save clip"));
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
