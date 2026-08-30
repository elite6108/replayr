import type { VideoPlayer } from "expo-video";

const players = new Set<VideoPlayer>();
let live = true;

function stopPlayer(player: VideoPlayer) {
  try {
    player.muted = true;
    player.pause();
  } catch {
    /* native player is already gone */
  }
  try {
    player.replace(null as never, true);
  } catch {
    /* replace is best-effort once the native instance is released */
  }
}

export function registerFeedPlayer(player: VideoPlayer) {
  players.add(player);
}

export function unregisterFeedPlayer(player: VideoPlayer) {
  stopPlayer(player);
  players.delete(player);
}

export function beginFeedPlayback() {
  live = true;
}

export function stopFeedPlayers() {
  live = false;
  for (const player of players) stopPlayer(player);
}

export function feedPlaybackAllowed() {
  return live;
}
