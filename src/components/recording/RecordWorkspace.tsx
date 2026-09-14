import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ClipStudio } from "./ClipStudio";
import { RecordingStudio } from "./RecordingStudio";
import { StudioShell, type StudioTab } from "./StudioShell";

const TAB_KEY = "replay.recordStudioTab";

function storedTab(): StudioTab {
  try {
    return localStorage.getItem(TAB_KEY) === "clip" ? "clip" : "recording";
  } catch {
    return "recording";
  }
}

export function RecordWorkspace() {
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState<StudioTab>(() => (params.get("studio") === "clip" ? "clip" : storedTab()));

  useEffect(() => {
    try {
      localStorage.setItem(TAB_KEY, tab);
    } catch {
      /* private mode */
    }
  }, [tab]);

  // The deep link from Settings is a one-shot: drop it once it has selected the tab so a later
  // manual switch is not undone by a refresh.
  useEffect(() => {
    if (!params.has("studio")) return;
    const next = new URLSearchParams(params);
    next.delete("studio");
    setParams(next, { replace: true });
  }, [params, setParams]);

  return (
    <StudioShell tab={tab} onTab={setTab}>
      {/*
        Conditional render, never CSS-hidden. The capture preview tap is a global singleton in
        Rust (`retain_preview` / `release_preview`), so two mounted previews would fight over it
        and unmounting one would kill the other's feed.
      */}
      {tab === "clip" ? <ClipStudio /> : <RecordingStudio />}
    </StudioShell>
  );
}
