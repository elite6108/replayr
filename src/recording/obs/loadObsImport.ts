/** Read an OBS collection through Rust, then build the import plan against this PC's devices. */
import { listAudioDevices, listCameraDevices } from "../../services/tauri";
import {
  probeObsImageSizes,
  readObsSceneCollection,
  type ObsCollectionRef,
  type ObsImportContext,
} from "../../services/obsImport";
import { buildObsImport, collectImagePaths, type ObsImportPlan } from "./obsImport";
import { parseObsCollectionText } from "./obsSchema";
import type { Size } from "./obsGeometry";

export type ObsPlanResult = { ok: true; plan: ObsImportPlan } | { ok: false; error: string };

export async function loadObsImportPlan(ref: ObsCollectionRef, context: ObsImportContext): Promise<ObsPlanResult> {
  let text;
  try {
    text = await readObsSceneCollection(ref);
  } catch (caught) {
    return { ok: false, error: caught instanceof Error ? caught.message : "Could not open that OBS scene collection." };
  }
  const parsed = parseObsCollectionText(text.json, text.name);
  if (!parsed.ok) return parsed;
  const paths = collectImagePaths(parsed.collection);
  const [sizes, cameras, audioDevices] = await Promise.all([
    probeObsImageSizes(paths),
    listCameraDevices(),
    listAudioDevices(),
  ]);
  const imageSizes = new Map<string, Size | null>(
    paths.map((path, index) => {
      const size = sizes[index];
      return [path, size ? { w: size.width, h: size.height } : null];
    }),
  );
  const plan = buildObsImport(parsed.collection, {
    canvas: { w: context.canvas.width, h: context.canvas.height },
    monitors: context.monitors,
    cameras,
    audioDevices,
    imageSizes,
  });
  return { ok: true, plan };
}
