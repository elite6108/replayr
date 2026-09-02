import type { RecordingSourceCapability, RecordingSourceType } from "./scene";

export type SourceRegistryEntry = {
  type: RecordingSourceType;
  label: string;
  group: "capture" | "media" | "audio" | "overlay";
  capability: RecordingSourceCapability;
  unique: boolean;
  hint: string;
};

export const SOURCE_REGISTRY: readonly SourceRegistryEntry[] = [
  {
    type: "game",
    label: "Game Capture",
    group: "capture",
    capability: "recorded",
    unique: true,
    hint: "Uses the current auto-detected game window.",
  },
  {
    type: "display",
    label: "Desktop Capture",
    group: "capture",
    capability: "recorded",
    unique: true,
    hint: "Same capture path, labeled as the current display.",
  },
  {
    type: "window",
    label: "Window Capture",
    group: "capture",
    capability: "unsupported",
    unique: true,
    hint: "Coming later.",
  },
  {
    type: "webcam",
    label: "Webcam",
    group: "media",
    capability: "sidecar",
    unique: true,
    hint: "Recorded separately.",
  },
  {
    type: "image",
    label: "Image",
    group: "media",
    capability: "preview_only",
    unique: false,
    hint: "Preview only.",
  },
  {
    type: "text",
    label: "Text",
    group: "media",
    capability: "preview_only",
    unique: false,
    hint: "Preview only.",
  },
  {
    type: "browser",
    label: "Browser",
    group: "media",
    capability: "unsupported",
    unique: true,
    hint: "Coming later.",
  },
  {
    type: "captureCard",
    label: "Capture Card",
    group: "media",
    capability: "unsupported",
    unique: true,
    hint: "Coming later.",
  },
  {
    type: "videoFile",
    label: "Video File",
    group: "media",
    capability: "unsupported",
    unique: true,
    hint: "Coming later.",
  },
  {
    type: "microphone",
    label: "Microphone",
    group: "audio",
    capability: "recorded",
    unique: true,
    hint: "Mixed into the session.",
  },
  {
    type: "desktopAudio",
    label: "Desktop Audio",
    group: "audio",
    capability: "recorded",
    unique: true,
    hint: "Mixed into the session.",
  },
  {
    type: "gameAudio",
    label: "Game Audio",
    group: "audio",
    capability: "recorded",
    unique: true,
    hint: "Mixed into the session.",
  },
  {
    type: "audioFile",
    label: "Audio File",
    group: "audio",
    capability: "unsupported",
    unique: true,
    hint: "Coming later.",
  },
  {
    type: "replayrOverlay",
    label: "Replayr Overlay",
    group: "overlay",
    capability: "preview_only",
    unique: true,
    hint: "Preview only.",
  },
] as const;

export const REGISTRY_GROUPS: { id: SourceRegistryEntry["group"]; label: string }[] = [
  { id: "capture", label: "Capture" },
  { id: "media", label: "Media" },
  { id: "audio", label: "Audio" },
  { id: "overlay", label: "Overlay" },
];

export function registryEntry(type: RecordingSourceType): SourceRegistryEntry | undefined {
  return SOURCE_REGISTRY.find((entry) => entry.type === type);
}

export function capabilityCaption(capability: RecordingSourceCapability): string {
  if (capability === "preview_only") return "Preview only";
  if (capability === "unsupported") return "Coming later";
  if (capability === "sidecar") return "Recorded separately";
  return "Recorded";
}

export type SourceCapabilities = {
  preview: boolean;
  legacyOutput: "recorded" | "sidecar" | "none";
  composedOutput: boolean;
};

export const COMPOSED_VISUAL_TYPES: readonly RecordingSourceType[] = [
  "game",
  "display",
  "webcam",
  "image",
  "text",
  "replayrOverlay",
];

export const COMPOSED_FILTER_IDS = ["none", "bodycam", "dashcam", "vhs", "cinematic"] as const;
export type ComposedFilterId = (typeof COMPOSED_FILTER_IDS)[number];

export function sourceCapabilities(type: RecordingSourceType): SourceCapabilities {
  if (type === "game" || type === "display") {
    return { preview: true, legacyOutput: "recorded", composedOutput: true };
  }
  if (type === "webcam") {
    return { preview: true, legacyOutput: "sidecar", composedOutput: true };
  }
  if (type === "image" || type === "text" || type === "replayrOverlay") {
    return { preview: true, legacyOutput: "none", composedOutput: true };
  }
  if (type === "microphone" || type === "desktopAudio" || type === "gameAudio") {
    return { preview: false, legacyOutput: "recorded", composedOutput: true };
  }
  return { preview: false, legacyOutput: "none", composedOutput: false };
}

export function sourceComposedSupported(type: RecordingSourceType): boolean {
  return sourceCapabilities(type).composedOutput;
}

export function sourcePreviewSupported(type: RecordingSourceType): boolean {
  return sourceCapabilities(type).preview;
}

export function filterComposedSupported(id: string): boolean {
  return (COMPOSED_FILTER_IDS as readonly string[]).includes(id);
}

export function composedSourceCaption(type: RecordingSourceType): string | null {
  if (!sourceComposedSupported(type)) {
    return "Not yet available in composed recording";
  }
  if (type === "webcam" || type === "image" || type === "text" || type === "replayrOverlay") {
    return "Recorded";
  }
  return null;
}
