import { useEffect, useState } from "react";
import {
  ArrowCounterClockwise,
  CheckCircle,
  Crop,
  FrameCorners,
  Gauge,
  Info,
  Sparkle,
  SpeakerHigh,
  TextT,
} from "@phosphor-icons/react";
import type { ClipSourceLayout, LocalClip } from "../../types/clip";
import type { WebcamPlacement, WebcamShape } from "../../types/settings";
import { formatBytes, formatDuration } from "../../utils/format";
import { SECTION_SPEEDS, type SectionSpeed, type SectionText } from "./segments";

const TEXT_COLORS = ["#ffffff", "#000000", "#ffe14a", "#ff4d4d", "#7fd0ef"];

type Tool = "frame" | "audio" | "text" | "speed" | "effects";

const TOOLS: { id: Tool; label: string; icon: typeof FrameCorners; beta?: boolean }[] = [
  { id: "frame", label: "Frame", icon: FrameCorners },
  { id: "audio", label: "Audio", icon: SpeakerHigh },
  { id: "text", label: "Text", icon: TextT },
  { id: "speed", label: "Speed", icon: Gauge },
  { id: "effects", label: "Effects", icon: Sparkle, beta: true },
];

function aspectLabel(width: number, height: number): string {
  if (width <= 0 || height <= 0) return "—";
  const ratio = width / height;
  if (Math.abs(ratio - 16 / 9) / (16 / 9) < 0.03) return "16:9";
  if (Math.abs(ratio - 9 / 16) / (9 / 16) < 0.03) return "9:16";
  return ratio.toFixed(2);
}

export function EditorInspector({
  source,
  shortsMode,
  sourceIs16x9,
  pan,
  overlayVisible,
  onShortsMode,
  sections,
  onPan,
  onPersistPan,
  onResetPan,
  longSelection,
  selectedDurationMs,
  webcam,
  treatment,
}: {
  source: LocalClip;
  shortsMode: boolean;
  sourceIs16x9: boolean;
  pan: number;
  overlayVisible: boolean;
  onShortsMode: (enabled: boolean) => void;
  /** Present when the timeline has more than one kept section; gates the 9:16 frame. */
  sections: { count: number } | null;
  onPan: (value: number) => void;
  onPersistPan: () => void;
  onResetPan: () => void;
  longSelection: boolean;
  selectedDurationMs: number;
  treatment: {
    gameVolume: number;
    micVolume: number;
    speed: SectionSpeed;
    text: SectionText | null;
    hasMic: boolean;
    onGameVolume: (value: number) => void;
    onMicVolume: (value: number) => void;
    onSpeed: (speed: SectionSpeed) => void;
    onText: (text: SectionText | null) => void;
  };
  webcam: {
    layout: ClipSourceLayout;
    placements: { id: WebcamPlacement; label: string }[];
    shapes: { id: WebcamShape; label: string }[];
    onPlacement: (id: WebcamPlacement) => void;
    onShape: (id: WebcamShape) => void;
    onWidth: (percent: number) => void;
  } | null;
}) {
  const [tool, setTool] = useState<Tool>("frame");
  const [cropText, setCropText] = useState(pan.toFixed(2));
  const [cropFocused, setCropFocused] = useState(false);
  useEffect(() => {
    if (!cropFocused) setCropText(pan.toFixed(2));
  }, [pan, cropFocused]);
  const frame = sourceIs16x9 && !shortsMode ? "wide" : shortsMode ? "short" : "original";
  const helper =
    frame === "short" ? "Best for TikTok, Reels & Shorts" : frame === "wide" ? "Standard widescreen" : "Original clip dimensions";
  const detailWidth = shortsMode ? 1080 : source.width;
  const detailHeight = shortsMode ? 1920 : source.height;
  const sourceDurationMs = source.durationMs ?? 0;
  const selectedRatio = sourceDurationMs > 0 ? Math.min(1, selectedDurationMs / sourceDurationMs) : 1;
  const estimatedBytes = source.fileSize ? Math.max(1, Math.round(source.fileSize * selectedRatio)) : 0;
  return (
    <aside className="editor-inspector">
      <div className="editor-tool-panel" role="tabpanel">
        {tool === "frame" ? (
          <>
            <h2>Frame</h2>
            <div className="editor-section-label">
              <span>
                Frame &amp; Aspect Ratio
                <Info size={12} aria-hidden="true" />
              </span>
            </div>
            <div className="editor-aspects">
              <button type="button" className={frame === "original" ? "on" : ""} onClick={() => onShortsMode(false)}>
                <span className="editor-aspect-glyph original" />
                Original
              </button>
              <button type="button" className={frame === "wide" ? "on" : ""} disabled={!sourceIs16x9} onClick={() => onShortsMode(false)}>
                <span className="editor-aspect-glyph wide" />
                16:9
              </button>
              <button
                type="button"
                className={frame === "short" ? "on" : ""}
                disabled={sections !== null}
                title={sections ? "Shorts save a single section; join sections first" : undefined}
                onClick={() => onShortsMode(true)}
              >
                <span className="editor-aspect-glyph short" />
                9:16
              </button>
            </div>
            <p className={`editor-helper${frame === "short" ? " on" : ""}`}>{helper}</p>
            {longSelection ? <p className="editor-note">Longer than 60 seconds. You can still save.</p> : null}

            <div className="editor-split">
              <span className="editor-split-label">
                <Crop size={13} aria-hidden="true" />
                Crop &amp; Position
              </span>
              <button type="button" className="editor-reset-btn" disabled={!overlayVisible} onClick={onResetPan}>
                <ArrowCounterClockwise size={11} />
                Reset
              </button>
            </div>
            <div className="editor-xy">
              <label className={overlayVisible ? "" : "is-disabled"}>
                <span>X</span>
                <input
                  inputMode="decimal"
                  disabled={!overlayVisible}
                  aria-label="Horizontal crop"
                  title={overlayVisible ? "Horizontal pan, 0 to 1" : "Available in 9:16"}
                  value={overlayVisible ? cropText : "0"}
                  onFocus={() => setCropFocused(true)}
                  onChange={(event) => setCropText(event.target.value)}
                  onBlur={(event) => {
                    setCropFocused(false);
                    const next = Number(event.target.value);
                    if (Number.isFinite(next)) onPan(next);
                    onPersistPan();
                  }}
                />
              </label>
              <label className="is-disabled">
                <span>Y</span>
                <input disabled aria-label="Vertical crop" title="Coming later" value="0" readOnly />
              </label>
            </div>
            {overlayVisible ? (
              <label className="editor-slider">
                Horizontal pan
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.001}
                  value={pan}
                  aria-label="Horizontal pan"
                  onChange={(event) => onPan(Number(event.currentTarget.value))}
                  onPointerUp={onPersistPan}
                  onKeyUp={onPersistPan}
                />
              </label>
            ) : null}
            <label className="editor-slider editor-slider-row is-disabled">
              <span>Zoom</span>
              <input type="range" min={0} max={200} value={100} disabled aria-label="Zoom, coming later" title="Coming later" readOnly />
              <em>100 %</em>
            </label>
            <label className="editor-slider editor-slider-row is-disabled">
              <span>Rotate</span>
              <input type="range" min={-180} max={180} value={0} disabled aria-label="Rotate, coming later" title="Coming later" readOnly />
              <em>0°</em>
            </label>

            {webcam ? (
              <div className="editor-webcam-controls">
                <span className="editor-kicker">Webcam</span>
                <div className="placement-grid" role="group" aria-label="Webcam position">
                  {webcam.placements.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className={`placement-cell${webcam.layout.placement === item.id ? " on" : ""}`}
                      onClick={() => webcam.onPlacement(item.id)}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
                <div className="shape-row">
                  {webcam.shapes.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className={`chip${webcam.layout.shape === item.id ? " on" : ""}`}
                      onClick={() => webcam.onShape(item.id)}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
                <label className="editor-slider">
                  <span>
                    Size <em>{Math.round(webcam.layout.width * 100)}%</em>
                  </span>
                  <input
                    type="range"
                    min={12}
                    max={40}
                    value={Math.round(webcam.layout.width * 100)}
                    aria-label="Webcam size"
                    onChange={(event) => webcam.onWidth(Number(event.target.value))}
                  />
                </label>
              </div>
            ) : null}

            <div className="editor-section-label">
              <span>
                Clip Details
                <Info size={12} aria-hidden="true" />
              </span>
            </div>
            <dl className="editor-details">
              <div>
                <dt>Duration</dt>
                <dd>{formatDuration(selectedDurationMs)}</dd>
              </div>
              <div>
                <dt>Resolution</dt>
                <dd>
                  {detailWidth} × {detailHeight}
                </dd>
              </div>
              <div>
                <dt>Aspect Ratio</dt>
                <dd>{aspectLabel(detailWidth ?? 0, detailHeight ?? 0)}</dd>
              </div>
              <div>
                <dt>Estimated Size</dt>
                <dd>{estimatedBytes > 0 ? `~${formatBytes(estimatedBytes)}` : "—"}</dd>
              </div>
            </dl>
            <p className="editor-original-note">
              <CheckCircle size={13} weight="fill" aria-hidden="true" />
              Original recording stays unchanged.
            </p>
          </>
        ) : tool === "audio" ? (
          <>
            <h2>Audio</h2>
            <p className="editor-later">Levels are saved with this section. The slider under the video is only how loud you hear the preview.</p>
            <label className="editor-slider editor-slider-row">
              <span>Game</span>
              <input
                type="range"
                min={0}
                max={200}
                step={1}
                value={Math.round(treatment.gameVolume * 100)}
                aria-label="Game volume"
                onChange={(event) => treatment.onGameVolume(Number(event.currentTarget.value) / 100)}
              />
              <em>{Math.round(treatment.gameVolume * 100)}%</em>
            </label>
            {treatment.hasMic ? (
              <label className="editor-slider editor-slider-row">
                <span>Mic</span>
                <input
                  type="range"
                  min={0}
                  max={200}
                  step={1}
                  value={Math.round(treatment.micVolume * 100)}
                  aria-label="Microphone volume"
                  onChange={(event) => treatment.onMicVolume(Number(event.currentTarget.value) / 100)}
                />
                <em>{Math.round(treatment.micVolume * 100)}%</em>
              </label>
            ) : (
              <p className="editor-later">This clip has no microphone track.</p>
            )}
          </>
        ) : tool === "text" ? (
          <>
            <h2>Text</h2>
            <label className="editor-text-field">
              <span>Label</span>
              <input
                type="text"
                maxLength={80}
                placeholder="Add text"
                aria-label="Text"
                value={treatment.text?.text ?? ""}
                onChange={(event) => {
                  const value = event.target.value;
                  if (!value.trim()) {
                    treatment.onText(null);
                    return;
                  }
                  treatment.onText({
                    text: value,
                    color: treatment.text?.color ?? "#ffffff",
                    size: treatment.text?.size ?? 48,
                    x: treatment.text?.x ?? 0.5,
                    y: treatment.text?.y ?? 0.82,
                  });
                }}
              />
            </label>
            <div className="editor-swatches" role="group" aria-label="Text color">
              {TEXT_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  className={treatment.text?.color === color ? "on" : ""}
                  style={{ background: color }}
                  aria-label={color}
                  disabled={!treatment.text}
                  onClick={() => treatment.text && treatment.onText({ ...treatment.text, color })}
                />
              ))}
            </div>
            <label className={`editor-slider editor-slider-row${treatment.text ? "" : " is-disabled"}`}>
              <span>Size</span>
              <input
                type="range"
                min={24}
                max={96}
                step={2}
                disabled={!treatment.text}
                value={treatment.text?.size ?? 48}
                aria-label="Text size"
                onChange={(event) =>
                  treatment.text && treatment.onText({ ...treatment.text, size: Number(event.currentTarget.value) })
                }
              />
              <em>{treatment.text?.size ?? 48}</em>
            </label>
            <p className="editor-later">Drag the text on the video to place it.</p>
          </>
        ) : tool === "speed" ? (
          <>
            <h2>Speed</h2>
            <div className="editor-speeds" role="group" aria-label="Playback speed">
              {SECTION_SPEEDS.map((speed) => (
                <button
                  key={speed}
                  type="button"
                  className={treatment.speed === speed ? "on" : ""}
                  onClick={() => treatment.onSpeed(speed)}
                >
                  {speed}×
                </button>
              ))}
            </div>
            <p className="editor-later">This section plays at {treatment.speed}×. The saved clip uses that speed.</p>
          </>
        ) : (
          <p className="editor-later">Coming later</p>
        )}
      </div>
      <div className="editor-tool-rail" role="tablist" aria-label="Editor tools">
        {TOOLS.map((item) => {
          const Icon = item.icon;
          const active = tool === item.id;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={active}
              className={active ? "on" : ""}
              disabled={item.id === "effects"}
              title={item.id === "effects" ? "Effects are coming later" : undefined}
              onClick={() => setTool(item.id)}
            >
              <Icon size={18} weight={active ? "fill" : "regular"} />
              <span>{item.label}</span>
              {item.beta ? <span className="editor-beta editor-beta-tile">Beta</span> : null}
            </button>
          );
        })}
      </div>
    </aside>
  );
}
