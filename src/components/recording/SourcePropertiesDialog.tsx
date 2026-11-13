import type { AppSettings } from "../../types/settings";
import type { RecordingSource } from "../../recording/scene";
import { audioForSource, type AudioGlobals, type SourceAudio } from "../../recording/sourceAudio";
import type { DisplayInfo } from "../../recording/display/displayTypes";
import { formatDb } from "../../recording/useStudioAudio";
import { AudioChannelControls } from "../common/AudioChannelControls";
import { MicrophoneDeviceSelect } from "../common/MicrophoneDeviceSelect";
import { DisplaySourceSettings } from "./sources/DisplaySourceSettings";

export function SourcePropertiesDialog({
  source,
  settings,
  displays,
  listError = null,
  recording,
  onMonitorId,
  onSaveSetting,
  onSourceAudio,
  sources,
  onClose,
  strictDisplay = false,
  onRefreshDisplays,
}: {
  source: RecordingSource;
  settings: AppSettings;
  displays: DisplayInfo[];
  listError?: string | null;
  recording: boolean;
  strictDisplay?: boolean;
  onRefreshDisplays?: () => void;
  onMonitorId: (monitorId: string | null) => void;
  onSaveSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
  onSourceAudio?: (audio: SourceAudio) => void;
  sources?: RecordingSource[];
  onClose: () => void;
}) {
  const globals: AudioGlobals = {
    micGain: settings.micGain,
    microphoneId: settings.microphoneId,
    systemAudioGain: settings.systemAudioGain,
    gameAudioGain: settings.gameAudioGain,
    audioOutputId: settings.audioOutputId,
  };
  const owned = onSourceAudio ? audioForSource(source, sources ?? [source], globals) : null;
  const primary = (sources ?? [source]).find((item) => item.type === source.type);
  const sameDevice =
    source.type === "microphone" && primary && primary.id !== source.id && owned?.deviceId === audioForSource(primary, sources ?? [source], globals).deviceId;
  function saveGain(gain: number, key: "micGain" | "systemAudioGain" | "gameAudioGain") {
    if (owned && onSourceAudio) onSourceAudio({ ...owned, gain });
    else onSaveSetting(key, gain);
  }
  function saveDevice(deviceId: string, key: "microphoneId" | "audioOutputId") {
    if (owned && onSourceAudio) onSourceAudio({ ...owned, deviceId });
    else onSaveSetting(key, deviceId);
  }
  const title =
    source.type === "microphone"
      ? "Microphone Properties"
      : source.type === "desktopAudio"
        ? "Desktop Audio Properties"
        : source.type === "gameAudio"
          ? "Game Audio Properties"
          : source.type === "display"
            ? source.name
            : `${source.name} Properties`;

  return (
    <div className="studio-modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="studio-modal"
        role="dialog"
        aria-labelledby="source-properties-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="studio-block-head">
          <h2 id="source-properties-title">{title}</h2>
          <button type="button" className="studio-icon-btn" onClick={onClose}>
            Close
          </button>
        </div>
        {source.type === "display" ? (
          <DisplaySourceSettings
            source={source}
            displays={displays}
            listError={listError}
            recording={recording}
            onMonitorId={onMonitorId}
            strict={strictDisplay}
            onOpen={onRefreshDisplays}
          />
        ) : source.type === "microphone" ? (
          <div className="stack">
            <MicrophoneDeviceSelect
              id="mic-properties-device"
              deviceId={owned?.deviceId ?? settings.microphoneId}
              onDeviceId={(deviceId) => saveDevice(deviceId, "microphoneId")}
              disabled={recording}
              disabledReason="Stop recording to change microphone."
            />
            {sameDevice ? (
              <p className="muted">This microphone uses the same device as the first one, so it stays quiet until you pick another device.</p>
            ) : null}
            <GainField
              id="mic-properties-gain"
              gain={owned?.gain ?? settings.micGain}
              disabled={!source.enabled}
              onGain={(gain) => saveGain(gain, "micGain")}
            />
            <AudioChannelControls
              idPrefix="mic-properties"
              channelMode={settings.micChannelMode}
              pan={settings.micPan}
              panLabel="Pan"
              onChannelMode={(mode) => onSaveSetting("micChannelMode", mode)}
              onPan={(pan) => onSaveSetting("micPan", pan)}
            />
          </div>
        ) : source.type === "desktopAudio" ? (
          <div className="stack">
            <p className="muted">Full speaker mix. Gain applies to Desktop Audio in the session mix.</p>
            {onSourceAudio ? (
              <MicrophoneDeviceSelect
                id="desktop-properties-device"
                deviceId={owned?.deviceId ?? settings.audioOutputId}
                direction="render"
                onDeviceId={(deviceId) => saveDevice(deviceId, "audioOutputId")}
                disabled={recording}
                disabledReason="Stop recording to change the playback device."
              />
            ) : null}
            <GainField
              id="desktop-properties-gain"
              gain={owned?.gain ?? settings.systemAudioGain}
              disabled={!source.enabled}
              onGain={(gain) => saveGain(gain, "systemAudioGain")}
            />
            <AudioChannelControls
              idPrefix="desktop-properties"
              channelMode={settings.systemAudioChannelMode}
              pan={settings.systemAudioPan}
              panLabel="Balance / Pan"
              onChannelMode={(mode) => onSaveSetting("systemAudioChannelMode", mode)}
              onPan={(pan) => onSaveSetting("systemAudioPan", pan)}
            />
          </div>
        ) : source.type === "gameAudio" ? (
          <div className="stack">
            <p className="muted">Isolated game process audio. Gain applies when Game Audio is enabled.</p>
            <GainField
              id="game-properties-gain"
              gain={owned?.gain ?? settings.gameAudioGain}
              disabled={!source.enabled}
              onGain={(gain) => saveGain(gain, "gameAudioGain")}
            />
            <AudioChannelControls
              idPrefix="game-properties"
              channelMode={settings.gameAudioChannelMode}
              pan={settings.gameAudioPan}
              panLabel="Balance / Pan"
              onChannelMode={(mode) => onSaveSetting("gameAudioChannelMode", mode)}
              onPan={(pan) => onSaveSetting("gameAudioPan", pan)}
            />
          </div>
        ) : (
          <p className="studio-empty">No extra properties for this source.</p>
        )}
      </div>
    </div>
  );
}

function GainField({
  id,
  gain,
  disabled,
  onGain,
}: {
  id: string;
  gain: number;
  disabled?: boolean;
  onGain: (gain: number) => void;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>Gain ({formatDb(gain)})</label>
      <input
        id={id}
        type="range"
        min={0}
        max={200}
        step={1}
        disabled={disabled}
        value={Math.round(gain * 100)}
        onChange={(event) => onGain(Number(event.target.value) / 100)}
      />
    </div>
  );
}
