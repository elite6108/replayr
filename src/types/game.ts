export interface GameCatalogEntry {
  slug: string;
  cloudId: string | null;
  name: string;
  publisher: string | null;
  coverUrl: string | null;
  iconUrl: string | null;
  processNames: string[];
}

export interface CloudGame {
  id: string;
  slug: string;
  name: string;
  publisher: string | null;
  cover_url: string | null;
  icon_url: string | null;
  process_names: string[];
}

export interface RunningGame {
  slug: string;
  name: string;
  publisher: string | null;
  processName: string;
  pid: number;
  focused: boolean;
}

export interface DetectedGameSnapshot {
  slug: string | null;
  name: string | null;
  publisher: string | null;
  processName: string | null;
  pid: number | null;
  focused: boolean;
  running: RunningGame[];
}

export const EMPTY_DETECTION: DetectedGameSnapshot = {
  slug: null,
  name: null,
  publisher: null,
  processName: null,
  pid: null,
  focused: false,
  running: [],
};
