import assert from "node:assert/strict";
import test from "node:test";
import {
  audioGlobalsForScene,
  cleanDeviceId,
  extraMicrophonePlans,
  parseSourceAudio,
  sanitizeAudioSettings,
  stampAudioFromGlobals,
  type AudioGlobals,
} from "./sourceAudio.ts";

const globals: AudioGlobals = {
  micGain: 1,
  microphoneId: "default",
  systemAudioGain: 1,
  gameAudioGain: 1,
  audioOutputId: "default",
};

test("a source with no audio block keeps the shared levels", () => {
  assert.equal(parseSourceAudio(undefined), null);
  assert.deepEqual(audioGlobalsForScene([{ id: "microphone-a", type: "microphone", settings: {} }], globals), {});
});

test("an explicit level is what the scene asks the shared settings to become", () => {
  const writes = audioGlobalsForScene(
    [
      { id: "microphone-a", type: "microphone", settings: { audio: { gain: 0.5, deviceId: "{mic}" } } },
      { id: "desktop-a", type: "desktopAudio", settings: { audio: { gain: 0.25, deviceId: "{out}" } } },
      { id: "game-a", type: "gameAudio", settings: { audio: { gain: 1.5, deviceId: "ignored" } } },
    ],
    globals,
  );
  assert.deepEqual(writes, { micGain: 0.5, microphoneId: "{mic}", systemAudioGain: 0.25, audioOutputId: "{out}", gameAudioGain: 1.5 });
});

test("hostile audio settings are dropped or clamped", () => {
  assert.equal(parseSourceAudio({ gain: Number.NaN, deviceId: "x" }), null);
  assert.equal(cleanDeviceId(`bad\u0000id${"x".repeat(500)}`).length, 400);
  const cleaned = sanitizeAudioSettings("microphone", { audio: { gain: 9, deviceId: "  mic  " }, keep: true });
  assert.deepEqual(cleaned.audio, { gain: 2, deviceId: "mic" });
  assert.equal(cleaned.keep, true);
  assert.equal("audio" in sanitizeAudioSettings("image", { audio: { gain: 1, deviceId: "default" } }), false);
});

test("settings edits update a scene that already has its own level, and leave the others shared", () => {
  const sources = [
    { id: "microphone-a", type: "microphone", settings: { audio: { gain: 0.5, deviceId: "default" } } },
    { id: "microphone-b", type: "microphone", settings: { audio: { gain: 0.3, deviceId: "{2}" } } },
    { id: "desktop-a", type: "desktopAudio", settings: {} },
  ];
  const stamped = stampAudioFromGlobals(sources, { ...globals, micGain: 0.8 });
  assert.ok(stamped);
  const first = stamped[0];
  const second = stamped[1];
  assert.ok(first && second);
  const audio = (first.settings as { audio: { gain: number } }).audio;
  const extra = (second.settings as { audio: { gain: number; deviceId: string } }).audio;
  assert.equal(audio.gain, 0.8);
  assert.equal(extra.gain, 0.3);
  assert.equal(extra.deviceId, "{2}");
  assert.ok(stamped);
  assert.equal(stampAudioFromGlobals(stamped, { ...globals, micGain: 0.8 }), null);
});

test("only microphones after the first are extra captures, and the list stops at four", () => {
  const sources = [1, 2, 3, 4, 5].map((n) => ({
    id: `microphone-${n}`,
    type: "microphone",
    enabled: n !== 2,
    settings: { audio: { gain: n / 10, deviceId: n === 1 ? "default" : `{${n}}` } },
  }));
  const extras = extraMicrophonePlans(sources);
  assert.deepEqual(
    extras.map((mic) => mic.id),
    ["microphone-2", "microphone-3", "microphone-4"],
  );
  const firstExtra = extras[0];
  assert.ok(firstExtra);
  assert.equal(firstExtra.enabled, false);
  assert.equal(firstExtra.deviceId, "{2}");
});
