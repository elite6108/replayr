import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { fetchGames, supabaseConfigured } from "../services/supabase";
import { getDetectedGame, listGames, syncGames } from "../services/tauri";
import { EMPTY_DETECTION, type DetectedGameSnapshot, type GameCatalogEntry } from "../types/game";

interface DetectionState {
  ready: boolean;
  snapshot: DetectedGameSnapshot;
  sessionStartedAt: number | null;
  catalog: GameCatalogEntry[];
  error: string | null;
  initialize: () => Promise<void>;
  refreshCatalog: () => Promise<void>;
}

function cloudToLocal(games: Awaited<ReturnType<typeof fetchGames>>): GameCatalogEntry[] {
  return games.map((game) => ({
    slug: game.slug,
    cloudId: game.id,
    name: game.name,
    publisher: game.publisher,
    coverUrl: game.cover_url,
    iconUrl: game.icon_url,
    processNames: game.process_names ?? [],
  }));
}

let listening = false;

export const useDetectionStore = create<DetectionState>((set) => ({
  ready: false,
  snapshot: EMPTY_DETECTION,
  sessionStartedAt: null,
  catalog: [],
  error: null,
  initialize: async () => {
    try {
      const catalog = await listGames();
      set({ catalog });
      if (supabaseConfigured()) {
        try {
          const cloud = await fetchGames();
          if (cloud.length > 0) {
            const next = await syncGames(cloudToLocal(cloud));
            set({ catalog: next });
          }
        } catch (caught) {
          set({
            error: caught instanceof Error ? caught.message : "Could not refresh the cloud game catalog",
          });
        }
      }
      const snapshot = await getDetectedGame();
      set({
        snapshot,
        sessionStartedAt: snapshot.name ? Date.now() : null,
        ready: true,
      });
    } catch (caught) {
      set({
        ready: true,
        error: caught instanceof Error ? caught.message : "Game detection failed to start",
      });
    }

    if (!listening) {
      listening = true;
      await listen<DetectedGameSnapshot>("detected-game", (event) => {
        set((state) => {
          const next = event.payload;
          const sameSession =
            Boolean(next.name) &&
            state.snapshot.slug === next.slug &&
            state.snapshot.pid === next.pid;
          return {
            snapshot: next,
            sessionStartedAt: next.name
              ? sameSession
                ? state.sessionStartedAt ?? Date.now()
                : Date.now()
              : null,
          };
        });
      });
    }
  },
  refreshCatalog: async () => {
    if (!supabaseConfigured()) {
      const catalog = await listGames();
      set({ catalog, error: "Cloud catalog is unavailable. Using the local list." });
      return;
    }
    const cloud = await fetchGames();
    const catalog = await syncGames(cloudToLocal(cloud));
    set({ catalog, error: null });
  },
}));
