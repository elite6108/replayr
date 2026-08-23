import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { resolveMicDisconnect } from "../../services/tauri";
import { useSettingsStore } from "../../stores/settingsStore";
import { useToastStore } from "../../stores/toastStore";
import type { MicDisconnectedEvent } from "../../types/audio";

export function MicDisconnectToasts() {
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<MicDisconnectedEvent>("mic-disconnected", (event) => {
      const name = event.payload?.name?.trim() || "Microphone";
      useToastStore.getState().showSticky(`${name} disconnected. Video and system audio keep recording.`, [
        {
          label: "Use Windows Default Mic",
          onClick: () => {
            void resolveMicDisconnect("default")
              .then((settings) => useSettingsStore.setState({ settings }))
              .catch(() => {
                useToastStore.getState().show("Could not switch to the Windows default microphone.");
              });
          },
        },
        {
          label: "Keep Microphone Off",
          onClick: () => {
            void resolveMicDisconnect("off")
              .then((settings) => useSettingsStore.setState({ settings }))
              .catch(() => {
                useToastStore.getState().show("Could not keep the microphone off.");
              });
          },
        },
      ]);
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
