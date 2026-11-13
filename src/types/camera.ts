import type { CameraControlName } from "./settings";

export type CameraAvailability =
  | "idle"
  | "ready"
  | "previewing"
  | "recording"
  | "disconnected"
  | "permissionDenied"
  | "failed"
  | "unsupported";

export type CameraSubtype = "nv12" | "yuy2" | "mjpeg" | "rgb32" | "other";

export interface CameraDevice {
  id: string;
  name: string;
}

export interface CameraMode {
  width: number;
  height: number;
  fps: number;
  nativeSubtype: CameraSubtype;
}

export interface CameraStatus {
  enabled: boolean;
  availability: CameraAvailability;
  deviceId: string;
  deviceName: string;
  message: string;
  width: number;
  height: number;
  fps: number;
  nativeSubtype: CameraSubtype | null;
  readerSubtype: CameraSubtype | null;
  conversionPath: boolean;
  timestampFallback: boolean;
  estimatedMbPerMinute: number;
  recording: boolean;
  /** Instant Replay owns the webcam buffer (not a settings test record). */
  rolling: boolean;
  encoderName: string;
  encoderHardware: boolean;
  softwareFallback: boolean;
  droppedFrames: number;
  writtenFrames: number;
  testPath: string;
  sessionClock: boolean;
  sessionSkewMs: number;
}

/** One hardware control the camera reports, with its range and current value. */
export interface CameraControlInfo {
  name: CameraControlName;
  label: string;
  min: number;
  max: number;
  step: number;
  defaultValue: number;
  value: number;
  auto: boolean;
  autoSupported: boolean;
}

/** Metadata ahead of the JPEG bytes on the binary camera preview channel. */
export interface CameraPreviewHeader {
  width: number;
  height: number;
  mirrored: boolean;
  /** Monotonic encode id. 0 means no preview frame exists. */
  frameId: number;
  mimeType: string;
}

export const IDLE_CAMERA_STATUS: CameraStatus = {
  enabled: false,
  availability: "idle",
  deviceId: "",
  deviceName: "",
  message: "",
  width: 0,
  height: 0,
  fps: 0,
  nativeSubtype: null,
  readerSubtype: null,
  conversionPath: false,
  timestampFallback: false,
  estimatedMbPerMinute: 0,
  recording: false,
  rolling: false,
  encoderName: "",
  encoderHardware: false,
  softwareFallback: false,
  droppedFrames: 0,
  writtenFrames: 0,
  testPath: "",
  sessionClock: false,
  sessionSkewMs: 0,
};
