export interface RecordingStatus {
  active: boolean;
  path: string | null;
  target: string | null;
  startedAt: string | null;
  durationMs: number;
  error: string | null;
}

export const IDLE_RECORDING: RecordingStatus = {
  active: false,
  path: null,
  target: null,
  startedAt: null,
  durationMs: 0,
  error: null,
};

export interface ReplayStatus {
  enabled: boolean;
  active: boolean;
  bufferedMs: number;
  durationMs: number;
  target: string | null;
  error: string | null;
  diskFreeBytes: number | null;
  diskBlocked: boolean;
  saving: boolean;
}

export const IDLE_REPLAY: ReplayStatus = {
  enabled: false,
  active: false,
  bufferedMs: 0,
  durationMs: 60_000,
  target: null,
  error: null,
  diskFreeBytes: null,
  diskBlocked: false,
  saving: false,
};
