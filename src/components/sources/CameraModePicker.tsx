import { useEffect, useMemo, useState } from "react";
import { listCameraModes } from "../../services/tauri";
import type { CameraMode } from "../../types/camera";

export type CameraModeChoice = { width: number; height: number; fps: number };

/** Resolution and frame rate picker built from the modes the camera reports. */
export function CameraModePicker({
  idPrefix,
  deviceId,
  width,
  height,
  fps,
  disabled = false,
  onChange,
  onModesReady,
}: {
  idPrefix: string;
  deviceId: string;
  width: number;
  height: number;
  fps: number;
  disabled?: boolean;
  onChange: (next: CameraModeChoice) => void;
  onModesReady?: (ready: boolean) => void;
}) {
  const [modes, setModes] = useState<CameraMode[]>([]);

  useEffect(() => {
    if (!deviceId) {
      setModes([]);
      onModesReady?.(false);
      return;
    }
    let cancelled = false;
    onModesReady?.(false);
    void listCameraModes(deviceId)
      .then((listed) => {
        if (!cancelled) setModes(listed);
      })
      .catch(() => {
        if (!cancelled) setModes([]);
      })
      .finally(() => {
        if (!cancelled) onModesReady?.(true);
      });
    return () => {
      cancelled = true;
    };
    // onModesReady is a notification only; re-listing on its identity would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId]);

  const resolutions = useMemo(() => uniqueResolutions(modes), [modes]);
  const frameRates = useMemo(() => uniqueFps(modes, width, height), [modes, width, height]);
  const smoother = useMemo(() => smootherMode(modes, width, height, fps), [modes, width, height, fps]);

  return (
    <>
      <div className="field">
        <label htmlFor={`${idPrefix}-res`}>Resolution</label>
        <select
          id={`${idPrefix}-res`}
          value={`${width}x${height}`}
          disabled={disabled}
          onChange={(event) => {
            const [nextWidth = width, nextHeight = height] = event.target.value.split("x").map(Number);
            const rates = uniqueFps(modes, nextWidth, nextHeight);
            onChange({ width: nextWidth, height: nextHeight, fps: rates.includes(fps) ? fps : (rates[rates.length - 1] ?? 30) });
          }}
        >
          {(resolutions.length ? resolutions : [{ width: 1280, height: 720 }]).map((mode) => (
            <option key={`${mode.width}x${mode.height}`} value={`${mode.width}x${mode.height}`}>
              {mode.height}p
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor={`${idPrefix}-fps`}>Frame rate</label>
        <select
          id={`${idPrefix}-fps`}
          value={fps}
          disabled={disabled}
          onChange={(event) => onChange({ width, height, fps: Number(event.target.value) })}
        >
          {(frameRates.length ? frameRates : [30]).map((rate) => (
            <option key={rate} value={rate}>
              {rate} FPS{rate >= 60 ? " (smoother)" : ""}
            </option>
          ))}
        </select>
      </div>
      {smoother ? (
        <button
          type="button"
          className="btn ghost sm"
          disabled={disabled}
          onClick={() => onChange(smoother)}
        >
          Use {smoother.height}p {smoother.fps} FPS (smoother)
        </button>
      ) : null}
    </>
  );
}

const SUPPORTED_HEIGHTS = new Set([480, 720, 1080]);
const SUPPORTED_FPS = new Set([24, 30, 60]);

function uniqueResolutions(modes: CameraMode[]): { width: number; height: number }[] {
  const seen = new Set<string>();
  const out: { width: number; height: number }[] = [];
  for (const mode of modes) {
    if (!SUPPORTED_HEIGHTS.has(mode.height)) continue;
    const key = `${mode.width}x${mode.height}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ width: mode.width, height: mode.height });
  }
  return out.sort((a, b) => a.height - b.height);
}

function uniqueFps(modes: CameraMode[], width: number, height: number): number[] {
  const fps = new Set<number>();
  for (const mode of modes) {
    if (mode.width === width && mode.height === height && SUPPORTED_FPS.has(mode.fps)) fps.add(mode.fps);
  }
  if (!fps.size) fps.add(30);
  return [...fps].sort((a, b) => a - b);
}

/** The sharpest 60 fps mode, when the current mode is below 60 fps. */
function smootherMode(modes: CameraMode[], width: number, height: number, fps: number): CameraModeChoice | null {
  if (fps >= 60) return null;
  const candidates = modes
    .filter((mode) => mode.fps === 60 && SUPPORTED_HEIGHTS.has(mode.height))
    .sort((a, b) => b.height - a.height);
  const best = candidates[0];
  if (!best || (best.width === width && best.height === height && fps === 60)) return null;
  return { width: best.width, height: best.height, fps: 60 };
}
