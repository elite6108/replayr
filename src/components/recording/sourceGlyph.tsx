import {
  Browser,
  FilmStrip,
  GameController,
  Image,
  Microphone,
  Monitor,
  MusicNote,
  Sparkle,
  SpeakerHigh,
  TextT,
  VideoCamera,
  Webcam,
  AppWindow,
} from "@phosphor-icons/react";
import type { RecordingSourceType } from "../../recording/scene";

export function SourceGlyph({ type }: { type: RecordingSourceType }) {
  return <span className="studio-source-glyph" aria-hidden="true">{glyph(type)}</span>;
}

function glyph(type: RecordingSourceType) {
  const props = { size: 16, weight: "regular" as const };
  switch (type) {
    case "webcam":
      return <Webcam {...props} />;
    case "microphone":
      return <Microphone {...props} />;
    case "desktopAudio":
      return <SpeakerHigh {...props} />;
    case "gameAudio":
      return <GameController {...props} />;
    case "image":
      return <Image {...props} />;
    case "text":
      return <TextT {...props} />;
    case "replayrOverlay":
      return <Sparkle {...props} />;
    case "game":
      return <GameController {...props} />;
    case "display":
      return <Monitor {...props} />;
    case "window":
      return <AppWindow {...props} />;
    case "browser":
      return <Browser {...props} />;
    case "captureCard":
      return <FilmStrip {...props} />;
    case "videoFile":
      return <VideoCamera {...props} />;
    case "audioFile":
      return <MusicNote {...props} />;
    default:
      return <Monitor {...props} />;
  }
}
