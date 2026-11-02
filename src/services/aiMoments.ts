import { publicApiUrl } from "../branding";

export const TRANSCRIPT_LIMIT_MS = 45 * 60 * 1000;

export type MomentFormat = "reel" | "youtube";

export type MomentQuota = {
  premium: boolean;
  transcriptionLimitSeconds: number;
  transcriptionUsedSeconds: number;
  transcriptionRemainingSeconds: number;
  rankingLimit: number;
  rankingUsed: number;
  month: string;
};

export type SuggestedMoment = {
  startMs: number;
  endMs: number;
  title: string;
  reason: string;
};

export type TranscriptResult = {
  transcriptId: string;
  durationMs: number;
  cached: boolean;
};

async function readJson<T>(response: Response, fallback: string): Promise<T> {
  const text = await response.text();
  let body: { error?: string } = {};
  try {
    body = text ? (JSON.parse(text) as { error?: string }) : {};
  } catch {
    body = {};
  }
  if (!response.ok) throw new Error(body.error || fallback);
  return body as T;
}

function authHeaders(token: string): HeadersInit {
  return { accept: "application/json", authorization: `Bearer ${token}` };
}

export async function fetchMomentQuota(token: string): Promise<MomentQuota> {
  const response = await fetch(`${publicApiUrl()}/v1/ai/moments/quota`, { headers: authHeaders(token) });
  return readJson<MomentQuota>(response, "Could not load the AI allowance.");
}

export async function transcribeClipAudio(token: string, parts: Blob[]): Promise<TranscriptResult> {
  const form = new FormData();
  for (const part of parts) form.append("part", part, "speech.m4a");
  const response = await fetch(`${publicApiUrl()}/v1/ai/moments/transcribe`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  return readJson<TranscriptResult>(response, "Could not transcribe this clip.");
}

export async function rankClipMoments(
  token: string,
  transcriptId: string,
  format: MomentFormat,
): Promise<SuggestedMoment[]> {
  const response = await fetch(`${publicApiUrl()}/v1/ai/moments`, {
    method: "POST",
    headers: { ...authHeaders(token), "content-type": "application/json" },
    body: JSON.stringify({ transcriptId, format }),
  });
  const body = await readJson<{ moments?: SuggestedMoment[] }>(response, "Could not pick moments.");
  return Array.isArray(body.moments) ? body.moments : [];
}
