export interface RecordingStatus {
  active: boolean;
  path: string | null;
  target: string | null;
  startedAt: string | null;
  durationMs: number;
  error: string | null;
  composed?: boolean;
}

export const IDLE_RECORDING: RecordingStatus = {
  active: false,
  path: null,
  target: null,
  startedAt: null,
  durationMs: 0,
  error: null,
  composed: false,
};

export interface IrEncoderStatus {
  width: number;
  height: number;
  fps: number;
  requestedBitrateBps: number;
  activeTargetBitrateBps: number;
  encoderReportedBitrateBps: number | null;
  recentFileBitrateBps: number | null;
  droppedFrames: number;
  lastRotationMs: number;
}

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
  settingsPending?: boolean;
  bitrateRestartPending?: boolean;
  restarting?: boolean;
  encoder?: IrEncoderStatus | null;
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
