import { invoke } from "@tauri-apps/api/core";
import { publicApiUrl } from "../branding";
import type { DetectedGameSnapshot } from "../types/game";

const reported = new Set<string>();

export function maybeReportLearnedGame(snapshot: Pick<DetectedGameSnapshot, "slug" | "name" | "processName">) {
  if (!snapshot.name || snapshot.slug || !snapshot.processName) return;
  const key = `${snapshot.processName.toLowerCase()}\n${snapshot.name}`;
  if (reported.has(key)) return;
  reported.add(key);
  void sendLearnedGame(snapshot.processName, snapshot.name).catch(() => {
    reported.delete(key);
  });
}

async function sendLearnedGame(processName: string, windowTitle: string) {
  const installHash = await invoke<string>("game_observation_hash", { processName });
  const response = await fetch(`${publicApiUrl()}/v1/games/observations`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ processName, windowTitle, installHash }),
  });
  if (!response.ok) throw new Error("Could not report that game.");
}
