/** Match the devices an OBS collection names to the devices connected to this PC. */
import type { AudioDevice } from "../../types/audio";
import type { CameraDevice } from "../../types/camera";
import { cleanString, settingNumber, settingString } from "./obsSchema";

export type ObsMonitorInfo = {
  /** `\\.\DISPLAYn`. */
  id: string;
  /** Device-interface path, as OBS stores it in `monitor_id`. May be empty. */
  interfaceId: string;
  width: number;
  height: number;
};

export type MonitorMatch = { monitor: ObsMonitorInfo; exact: boolean } | null;

/**
 * OBS 28+ stores the monitor's device-interface path; older versions store an index into the
 * monitor list, which is only a best guess here because the enumeration order can differ.
 */
export function matchMonitor(settings: Readonly<Record<string, unknown>>, monitors: ObsMonitorInfo[]): MonitorMatch {
  const wanted = settingString(settings, "monitor_id", 512).toLowerCase();
  if (wanted && wanted !== "dummy") {
    const exact = monitors.find((monitor) => monitor.interfaceId && monitor.interfaceId.toLowerCase() === wanted);
    if (exact) return { monitor: exact, exact: true };
    const display = /^\\\\\.\\display\d+$/.test(wanted) ? monitors.find((monitor) => monitor.id.toLowerCase() === wanted) : undefined;
    if (display) return { monitor: display, exact: true };
  }
  const index = settingNumber(settings, "monitor", -1, -1, 64);
  if (Number.isInteger(index) && index >= 0 && index < monitors.length) {
    const monitor = monitors[index];
    if (monitor) return { monitor, exact: false };
  }
  return null;
}

/**
 * OBS saves cameras as `Friendly Name:\\?\usb#vid_…#{interface-guid}\global`. Media Foundation
 * reports the same device instance under a different interface GUID, so compare the instance
 * part, then fall back to the friendly name.
 */
export function matchCamera(settings: Readonly<Record<string, unknown>>, cameras: CameraDevice[]): CameraDevice | null {
  const raw = settingString(settings, "video_device_id", 1024);
  if (!raw) return null;
  const split = raw.indexOf(":\\\\?\\");
  const colon = split >= 0 ? split : raw.lastIndexOf(":");
  const name = (colon >= 0 ? raw.slice(0, colon) : raw).trim().toLowerCase();
  const instance = split >= 0 ? deviceInstance(raw.slice(split + 1)) : "";
  if (instance) {
    const byInstance = cameras.find((camera) => deviceInstance(camera.id) === instance);
    if (byInstance) return byInstance;
  }
  return cameras.find((camera) => camera.name.trim().toLowerCase() === name) ?? null;
}

function deviceInstance(path: string): string {
  const lower = path.trim().toLowerCase();
  const cut = lower.lastIndexOf("#{");
  return cut > 0 ? lower.slice(0, cut) : "";
}

export type AudioMatch = { id: string; name: string } | null;

/** OBS uses `default` for the Windows default device, the same id Replayr stores. */
export function matchAudioDevice(
  settings: Readonly<Record<string, unknown>>,
  devices: AudioDevice[],
  direction: AudioDevice["direction"],
): AudioMatch {
  const wanted = settingString(settings, "device_id", 512);
  if (!wanted || wanted.toLowerCase() === "default") return { id: "default", name: "Default" };
  const found = devices.find((device) => device.direction === direction && device.id.toLowerCase() === wanted.toLowerCase());
  return found ? { id: found.id, name: cleanString(found.name, 128) || "Device" } : null;
}

/** `1920x1080` → size, when the webcam was set to a custom resolution in OBS. */
export function cameraResolution(settings: Readonly<Record<string, unknown>>): { w: number; h: number } | null {
  if (settingNumber(settings, "res_type", 0) !== 1) return null;
  const match = /^(\d{2,5})x(\d{2,5})$/.exec(settingString(settings, "resolution", 16));
  if (!match) return null;
  const w = Number(match[1]);
  const h = Number(match[2]);
  return w >= 16 && h >= 16 && w <= 16_384 && h <= 16_384 ? { w, h } : null;
}
