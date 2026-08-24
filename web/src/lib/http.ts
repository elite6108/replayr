export async function readApiJson<T>(response: Response, fallback: string): Promise<T> {
  const body = await parseJsonBody<T>(response, fallback);
  if (!response.ok) throw new Error(body.error || fallback);
  return body;
}

export async function readApiError(response: Response, fallback: string): Promise<string> {
  try {
    const body = await parseJsonBody<{ error?: string }>(response, fallback);
    return body.error || fallback;
  } catch {
    return fallback;
  }
}

async function parseJsonBody<T>(response: Response, fallback: string): Promise<T & { error?: string }> {
  const text = await response.text();
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error(response.ok ? fallback : `${fallback} (${response.status})`);
  }
  try {
    return JSON.parse(trimmed) as T & { error?: string };
  } catch {
    throw new Error(response.ok ? fallback : `${fallback} (${response.status})`);
  }
}
