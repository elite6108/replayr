export type CameraAvailability =
  | "idle"
  | "ready"
  | "previewing"
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
}

export interface CameraPreviewFrame {
  pngBase64: string;
  width: number;
  height: number;
  mirrored: boolean;
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
};
