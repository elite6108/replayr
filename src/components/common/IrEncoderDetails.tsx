import type { ReplayStatus } from "../../types/recording";

function mbps(value: number) {
  return `${(value / 1_000_000).toFixed(1)} Mbps`;
}

/** Displays backend state; lifecycle changes are serialized by the backend. */
export function IrEncoderDetails({ replay }: { replay: ReplayStatus }) {
  if (replay.restarting) return <p className="muted" role="status">Applying bitrate — restarting Instant Replay and refilling the buffer…</p>;
  if (!replay.active) return null;
  const encoder = replay.encoder;
  if (!encoder) {
    return replay.settingsPending ? (
      <p className="muted" role="status">
        Quality settings are pending. Save wanted clips before restarting Instant Replay;
        restarting clears the rolling buffer.
      </p>
    ) : null;
  }
  const pending = replay.bitrateRestartPending;
  return (
    <div className="muted" aria-label="Instant Replay encoder status">
      <div>
        IR: {encoder.width} × {encoder.height} · {encoder.fps} FPS · Requested {mbps(encoder.requestedBitrateBps)}
        {" · "}Active target {mbps(encoder.activeTargetBitrateBps)}
      </div>
      <div>
        Encoder readback: {encoder.encoderReportedBitrateBps == null ? "unavailable" : mbps(encoder.encoderReportedBitrateBps)}
        {" · "}Recent segment file rate: {encoder.recentFileBitrateBps == null ? "measuring…" : `~${mbps(encoder.recentFileBitrateBps)}`}
      </div>
      {pending ? (
        <p role="status">Bitrate restart pending. Any active recording or clip save finishes first; then the rolling buffer will be cleared and refilled.</p>
      ) : null}
      {replay.error ? <p role="status">{replay.error}</p> : null}
      {replay.settingsPending && !pending ? (
        <p role="status">Resolution/FPS changes require an Instant Replay restart. Save wanted clips first; restarting clears the buffer.</p>
      ) : null}
      <small>
        Changing bitrate restarts the rolling buffer. A full buffer takes {Math.ceil(replay.durationMs / 1000)} seconds to refill; shorter clips are available sooner.
        {" "}File rate varies with motion and includes MP4 overhead; it is not the encoder target.
        {encoder.droppedFrames > 0 ? ` Capture queue drops: ${encoder.droppedFrames}.` : ""}
      </small>
    </div>
  );
}
