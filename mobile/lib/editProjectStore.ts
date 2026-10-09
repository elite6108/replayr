import * as FileSystem from "expo-file-system/legacy";
import { parseEditProject, type EditProject } from "./editProject";

function fileUri(slug: string) {
  const safe = slug.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80) || "clip";
  return FileSystem.documentDirectory ? `${FileSystem.documentDirectory}edit-${safe}.json` : null;
}

export async function loadEditProject(slug: string, clipId: string): Promise<EditProject | null> {
  const uri = fileUri(slug);
  if (!uri) return null;
  try {
    const raw = await FileSystem.readAsStringAsync(uri);
    return parseEditProject(JSON.parse(raw) as unknown, clipId);
  } catch {
    return null;
  }
}

export async function saveEditProject(project: EditProject): Promise<void> {
  const uri = fileUri(project.source.slug);
  if (!uri) return;
  await FileSystem.writeAsStringAsync(uri, JSON.stringify(project));
}

export type ExportJobRecord = {
  id: string;
  slug: string;
  status: "preparing" | "rendering" | "complete" | "failed" | "cancelled" | "interrupted";
  progress: number;
  outputPath: string | null;
  errorMessage: string | null;
  updatedAt: number;
};

const JOB_FILE = "export-job.json";

function jobUri() {
  return FileSystem.documentDirectory ? `${FileSystem.documentDirectory}${JOB_FILE}` : null;
}

export async function readExportJob(): Promise<ExportJobRecord | null> {
  const uri = jobUri();
  if (!uri) return null;
  try {
    const parsed = JSON.parse(await FileSystem.readAsStringAsync(uri)) as ExportJobRecord;
    if (!parsed || typeof parsed.slug !== "string") return null;
    if (parsed.status === "preparing" || parsed.status === "rendering") {
      return { ...parsed, status: "interrupted", errorMessage: "Export paused. Start it again.", updatedAt: Date.now() };
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function writeExportJob(job: ExportJobRecord): Promise<void> {
  const uri = jobUri();
  if (!uri) return;
  await FileSystem.writeAsStringAsync(uri, JSON.stringify(job));
}
