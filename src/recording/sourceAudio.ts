/**
 * Gain and device stored on a microphone, desktop or game-audio source.
 *
 * The recording engine still runs one microphone capture, one desktop loopback and one game
 * process capture. Those read the global settings, and the microphone meter reapplies the global
 * mic gain many times a second. A scene with no `audio` block therefore keeps today's shared
 * levels. The first source of each role that does have a block is copied into those globals when
 * the scene becomes active, which is what makes a scene keep its own level.
 *
 * Further microphones are not that capture. They are mixed by a separate list and never replace it.
 */

export const MAX_MICROPHONES = 4;
export const MAX_DEVICE_ID = 400;

export type SourceAudio = {
  /** Linear gain, 0 to 2. The same range as the mixer. */
  gain: number;
  /** `"default"` or a WASAPI endpoint id. */
  deviceId: string;
};

export type AudioGlobals = {
  micGain: number;
  microphoneId: string;
  systemAudioGain: number;
  gameAudioGain: number;
  audioOutputId: string;
};

const AUDIO_TYPES = new Set(["microphone", "desktopAudio", "gameAudio"]);

export function isSceneAudioType(type: string): boolean {
  return AUDIO_TYPES.has(type);
}

/** A usable block, or null when the source should keep following the global settings. */
export function parseSourceAudio(raw: unknown): SourceAudio | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const gain = (raw as { gain?: unknown }).gain;
  if (typeof gain !== "number" || !Number.isFinite(gain)) return null;
  return { gain: clampGain(gain), deviceId: cleanDeviceId((raw as { deviceId?: unknown }).deviceId) };
}

export function cleanDeviceId(raw: unknown): string {
  if (typeof raw !== "string") return "default";
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_DEVICE_ID);
  return cleaned || "default";
}

export function clampGain(gain: number): number {
  return Math.round(Math.min(2, Math.max(0, gain)) * 1000) / 1000;
}

/** Drop a hostile or partial block. Leave every other setting on the source alone. */
export function sanitizeAudioSettings(type: string, settings: unknown): Record<string, unknown> {
  const next = settings && typeof settings === "object" && !Array.isArray(settings) ? { ...(settings as Record<string, unknown>) } : {};
  if (!isSceneAudioType(type)) {
    delete next.audio;
    return next;
  }
  const audio = parseSourceAudio(next.audio);
  if (audio) next.audio = audio;
  else delete next.audio;
  return next;
}

export function effectiveAudio(settings: unknown, fallback: SourceAudio): SourceAudio {
  return parseSourceAudio(settings && typeof settings === "object" ? (settings as { audio?: unknown }).audio : null) ?? fallback;
}

/** The first source of a role follows the shared level. Later microphones start at unity until they have their own. */
export function audioForSource(source: AudioSourceLike, sources: readonly AudioSourceLike[], globals: AudioGlobals): SourceAudio {
  const primary = sources.find((item) => item.type === source.type)?.id === source.id;
  const fallback = primary ? fallbackAudio(source.type, globals) : { gain: 1, deviceId: "default" };
  return effectiveAudio(source.settings, fallback);
}

export function fallbackAudio(type: string, globals: AudioGlobals): SourceAudio {
  if (type === "microphone") return { gain: clampGain(globals.micGain), deviceId: cleanDeviceId(globals.microphoneId) };
  if (type === "desktopAudio") return { gain: clampGain(globals.systemAudioGain), deviceId: cleanDeviceId(globals.audioOutputId) };
  if (type === "gameAudio") return { gain: clampGain(globals.gameAudioGain), deviceId: "default" };
  return { gain: 1, deviceId: "default" };
}

type AudioSourceLike = { id: string; type: string; settings?: unknown };

export function sourcesOfType<T extends AudioSourceLike>(sources: readonly T[], type: string): T[] {
  return sources.filter((source) => source.type === type);
}

/** Global keys the active scene's primary sources want changed. Empty when nothing is explicit. */
export function audioGlobalsForScene(sources: readonly AudioSourceLike[], globals: AudioGlobals): Partial<AudioGlobals> {
  const writes: Partial<AudioGlobals> = {};
  const mic = explicit(sourcesOfType(sources, "microphone")[0]);
  if (mic) {
    if (mic.gain !== clampGain(globals.micGain)) writes.micGain = mic.gain;
    if (mic.deviceId !== cleanDeviceId(globals.microphoneId)) writes.microphoneId = mic.deviceId;
  }
  const desktop = explicit(sourcesOfType(sources, "desktopAudio")[0]);
  if (desktop) {
    if (desktop.gain !== clampGain(globals.systemAudioGain)) writes.systemAudioGain = desktop.gain;
    if (desktop.deviceId !== cleanDeviceId(globals.audioOutputId)) writes.audioOutputId = desktop.deviceId;
  }
  const game = explicit(sourcesOfType(sources, "gameAudio")[0]);
  if (game && game.gain !== clampGain(globals.gameAudioGain)) writes.gameAudioGain = game.gain;
  return writes;
}

/**
 * Copy the global levels back onto sources that already have their own block, so the Settings
 * page and the active scene stay on one value. Sources without a block are left untouched.
 */
export function stampAudioFromGlobals<T extends AudioSourceLike>(sources: readonly T[], globals: AudioGlobals): T[] | null {
  let changed = false;
  const seen = new Set<string>();
  const next = sources.map((source) => {
    if (!isSceneAudioType(source.type)) return source;
    const primary = !seen.has(source.type);
    seen.add(source.type);
    // Later microphones keep the level stored on them. The shared level belongs to the first.
    if (!primary || !parseSourceAudio(audioOf(source))) return source;
    const audio = fallbackAudio(source.type, globals);
    const current = parseSourceAudio(audioOf(source));
    if (current && current.gain === audio.gain && current.deviceId === audio.deviceId) return source;
    changed = true;
    const settings = { ...(source.settings as Record<string, unknown>), audio };
    return { ...source, settings };
  });
  return changed ? next : null;
}

export type ExtraMicPlan = { id: string; deviceId: string; gain: number; enabled: boolean };

/** Microphones after the first. The first one stays on the engine's existing capture. */
export function extraMicrophonePlans(
  sources: readonly (AudioSourceLike & { enabled?: boolean })[],
): ExtraMicPlan[] {
  return sourcesOfType(sources, "microphone")
    .slice(1, MAX_MICROPHONES)
    .map((source) => {
      const audio = effectiveAudio(source.settings, { gain: 1, deviceId: "default" });
      return { id: source.id, deviceId: audio.deviceId, gain: audio.gain, enabled: source.enabled !== false };
    });
}

function explicit(source: AudioSourceLike | undefined): SourceAudio | null {
  return source ? parseSourceAudio(audioOf(source)) : null;
}

function audioOf(source: AudioSourceLike): unknown {
  const settings = source.settings;
  if (!settings || typeof settings !== "object") return null;
  return (settings as { audio?: unknown }).audio;
}
