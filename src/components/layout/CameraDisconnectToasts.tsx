import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useToastStore } from "../../stores/toastStore";
import type { CameraStatus } from "../../types/camera";

export function CameraDisconnectToasts() {
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<{ status: CameraStatus }>("camera-status", (event) => {
      const status = event.payload?.status;
      if (status?.availability !== "disconnected") return;
      const name = status.deviceName?.trim() || "Camera";
      useToastStore.getState().show(`${name} disconnected. Gameplay keeps recording.`);
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return null;
}
