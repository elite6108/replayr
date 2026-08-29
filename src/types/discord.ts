export type DiscordPresenceMode = "disabled" | "disconnected" | "idle" | "game" | "clipping";

export interface DiscordPresenceStatus {
  mode: DiscordPresenceMode;
  discordConnected: boolean;
  currentPresenceGame: string | null;
  lastPresenceUpdate: number | null;
  lastPresenceError: string | null;
  lastDetails: string | null;
  lastState: string | null;
  lastLargeImage: string | null;
}
