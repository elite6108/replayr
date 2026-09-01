import type {
  GameplayVisualFilter,
  RecordingOverlaySettings,
  RecordingVisualSettings,
} from "../types/settings";
import { DEFAULT_RECORDING_VISUALS } from "../types/settings";

export type VisualFilterDefinition = {
  id: GameplayVisualFilter;
  label: string;
  description: string;
  suggestedOverlays: RecordingOverlaySettings;
};

export const VISUAL_FILTERS: readonly VisualFilterDefinition[] = [
  {
    id: "none",
    label: "None",
    description: "Clean composition. No filter chrome.",
    suggestedOverlays: { recIndicator: false, timestamp: false },
  },
  {
    id: "bodycam",
    label: "Bodycam",
    description: "Vignette, REC, and a body-worn timestamp.",
    suggestedOverlays: { recIndicator: true, timestamp: true },
  },
  {
    id: "dashcam",
    label: "Dashcam",
    description: "Wide frame, REC, and a driving timestamp.",
    suggestedOverlays: { recIndicator: true, timestamp: true },
  },
  {
    id: "vhs",
    label: "VHS",
    description: "Scanlines and tape noise. Overlays stay optional.",
    suggestedOverlays: { recIndicator: false, timestamp: false },
  },
  {
    id: "cinematic",
    label: "Cinematic",
    description: "Letterbox and contrast. Overlays stay optional.",
    suggestedOverlays: { recIndicator: false, timestamp: false },
  },
] as const;

export function visualFilterDefinition(id: GameplayVisualFilter): VisualFilterDefinition {
  return (
    VISUAL_FILTERS.find((item) => item.id === id) ?? {
      id: "none",
      label: "None",
      description: "Clean composition. No filter chrome.",
      suggestedOverlays: { recIndicator: false, timestamp: false },
    }
  );
}

export function sanitizeRecordingVisuals(value: RecordingVisualSettings | null | undefined): RecordingVisualSettings {
  const filter = VISUAL_FILTERS.some((item) => item.id === value?.filter) ? value!.filter : DEFAULT_RECORDING_VISUALS.filter;
  return {
    filter,
    overlays: {
      recIndicator: Boolean(value?.overlays?.recIndicator),
      timestamp: Boolean(value?.overlays?.timestamp),
    },
  };
}

export function visualsForFilterSelect(id: GameplayVisualFilter): RecordingVisualSettings {
  const definition = visualFilterDefinition(id);
  return {
    filter: definition.id,
    overlays: { ...definition.suggestedOverlays },
  };
}

export function cameraPreviewAllowed(camera: { recording: boolean; rolling: boolean }): boolean {
  return !camera.rolling && !camera.recording;
}

export function cameraPreviewLabel(
  webcamEnabled: boolean,
  deviceId: string,
  camera: { recording: boolean; rolling: boolean },
): "Off" | "Live" | "In use" {
  if (!webcamEnabled || !deviceId) return "Off";
  if (!cameraPreviewAllowed(camera)) return "In use";
  return "Live";
}
