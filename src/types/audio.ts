export type AudioDirection = "capture" | "render";

export interface AudioDevice {
  id: string;
  name: string;
  direction: AudioDirection;
  isDefault: boolean;
}

export interface MicDisconnectedEvent {
  deviceId: string;
  name: string;
}

export interface AudioSession {
  pid: number;
  exe: string;
  displayName: string;
}

export interface AudioSourceStatus {
  id: string;
  displayName: string;
  enabled: boolean;
  running: boolean;
  capturing: boolean;
  isolationFailed: boolean;
  status: string;
  peak: number;
  gain: number;
}

export interface DetectedExtraApp {
  id: string;
  exe: string;
  displayName: string;
  running: boolean;
  added: boolean;
}

export interface AudioEngineStatus {
  processLoopbackSupported: boolean;
  osBuild: number;
  extraCount: number;
  extraCap: number;
  game: AudioSourceStatus;
  desktop: AudioSourceStatus;
  discord: AudioSourceStatus;
  extras: AudioSourceStatus[];
  detectedExtras: DetectedExtraApp[];
}
