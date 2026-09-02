import { useEffect, useState } from "react";
import { getAudioStatus, getMicLevel } from "../services/tauri";
import type { AudioEngineStatus } from "../types/audio";
import type { RecordingSourceType } from "./scene";

function clampPeak(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Fast attack, slower release so meters fall like a VU instead of jumping. */
function approachPeak(previous: number, next: number) {
  const target = clampPeak(next);
  const rate = target > previous ? 0.62 : 0.16;
  const value = previous + (target - previous) * rate;
  return Math.abs(value - target) < 0.004 ? target : value;
}

export function useStudioAudio() {
  const [audio, setAudio] = useState<AudioEngineStatus | null>(null);
  const [levels, setLevels] = useState({ micPeak: 0, gamePeak: 0, desktopPeak: 0 });

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      void Promise.all([getAudioStatus().catch(() => null), getMicLevel().catch(() => 0)]).then(([status, mic]) => {
        if (cancelled) return;
        if (status) setAudio(status);
        setLevels((previous) => ({
          micPeak: approachPeak(previous.micPeak, typeof mic === "number" ? mic : 0),
          gamePeak: approachPeak(previous.gamePeak, status?.game.peak ?? 0),
          desktopPeak: approachPeak(previous.desktopPeak, status?.desktop.peak ?? 0),
        }));
      });
    };
    tick();
    const timer = window.setInterval(tick, 80);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  return {
    audio,
    ...levels,
  };
}

export function audioPeakFor(type: RecordingSourceType, levels: { micPeak: number; gamePeak: number; desktopPeak: number }) {
  if (type === "microphone") return levels.micPeak;
  if (type === "gameAudio") return levels.gamePeak;
  if (type === "desktopAudio") return levels.desktopPeak;
  return 0;
}

export function formatDb(gain: number) {
  const db = 20 * Math.log10(Math.max(gain, 0.0001));
  const rounded = Math.round(db * 10) / 10;
  return `${rounded > 0 ? "+" : ""}${rounded.toFixed(1)} dB`;
}

export function formatPeakDb(peak: number) {
  if (peak <= 0.0008) return "—";
  return `${(20 * Math.log10(peak)).toFixed(1)} dB`;
}
