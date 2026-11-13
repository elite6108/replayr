import { invoke } from "@tauri-apps/api/core";
import { invokeErrorMessage } from "../utils/format";
import type { ObsMonitorInfo } from "../recording/obs/obsDevices";

export type ObsCollectionInfo = {
  /** Bare file name inside the OBS scenes folder. */
  file: string;
  name: string;
  modifiedMs: number;
  current: boolean;
};

export type ObsImportContext = {
  installed: boolean;
  collections: ObsCollectionInfo[];
  canvas: { width: number; height: number };
  monitors: ObsMonitorInfo[];
};

export type ObsCollectionText = { name: string; json: string };

/** A listed collection by file name, or a `.json` file the user picked. */
export type ObsCollectionRef = { file: string } | { path: string };

export async function getObsImportContext(): Promise<ObsImportContext> {
  try {
    return await invoke<ObsImportContext>("get_obs_import_context");
  } catch (caught) {
    throw new Error(invokeErrorMessage(caught, "Could not read the OBS settings."));
  }
}

export async function readObsSceneCollection(ref: ObsCollectionRef): Promise<ObsCollectionText> {
  const args = "file" in ref ? { file: ref.file, path: null } : { file: null, path: ref.path };
  try {
    return await invoke<ObsCollectionText>("read_obs_scene_collection", args);
  } catch (caught) {
    throw new Error(invokeErrorMessage(caught, "Could not open that OBS scene collection."));
  }
}

export async function probeObsImageSizes(paths: string[]): Promise<({ width: number; height: number } | null)[]> {
  if (!paths.length) return [];
  try {
    const sizes = await invoke<({ width: number; height: number } | null)[]>("probe_obs_image_sizes", { paths });
    return Array.isArray(sizes) ? sizes : paths.map(() => null);
  } catch {
    return paths.map(() => null);
  }
}
