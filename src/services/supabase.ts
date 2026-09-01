import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { publicApiUrl } from "../branding";
import { credentialStorage } from "./tauri";
import type { CloudClip } from "../types/clip";
import type { CloudGame } from "../types/game";
import type { Profile, UserStorage } from "../types/profile";
import { readApiJson } from "../utils/http";

let client: SupabaseClient | null = null;

export function supabaseConfigured(): boolean {
  return Boolean(import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY);
}

export function getSupabase(): SupabaseClient {
  if (client) return client;
  const url = import.meta.env.VITE_SUPABASE_URL;
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error("Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.");
  }
  client = createClient(url, anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      flowType: "pkce",
      storage: credentialStorage,
      storageKey: "tv.elite.replay.auth",
    },
  });
  return client;
}

export async function fetchOwnProfile(userId: string): Promise<Profile | null> {
  const { data, error } = await getSupabase()
    .from("profiles")
    .select(
      "id, username, display_name, avatar_url, bio, created_at, updated_at, is_verified, is_private, followers_count, following_count, clip_count",
    )
    .eq("id", userId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function updateOwnProfile(
  userId: string,
  patch: Partial<Pick<Profile, "username" | "display_name" | "bio" | "is_private">>,
): Promise<Profile> {
  const { data, error } = await getSupabase()
    .from("profiles")
    .update(patch)
    .eq("id", userId)
    .select(
      "id, username, display_name, avatar_url, bio, created_at, updated_at, is_verified, is_private, followers_count, following_count, clip_count",
    )
    .single();
  if (error) throw error;
  return data;
}

export async function fetchOwnStorage(userId: string): Promise<UserStorage | null> {
  const { data, error } = await getSupabase()
    .from("user_storage")
    .select("user_id, storage_used_bytes, storage_limit_bytes, updated_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function updateOwnClipTitle(userId: string, clipId: string, title: string): Promise<void> {
  const trimmed = title.trim();
  if (!trimmed) throw new Error("Clip name cannot be empty.");
  const { error } = await getSupabase().from("clips").update({ title: trimmed }).eq("id", clipId).eq("user_id", userId);
  if (error) throw error;
}

export async function updateOwnClipVisibility(
  userId: string,
  clipId: string,
  visibility: CloudClip["visibility"],
): Promise<void> {
  const { error } = await getSupabase().from("clips").update({ visibility }).eq("id", clipId).eq("user_id", userId);
  if (error) throw error;
}

export async function fetchOwnClipStatuses(
  userId: string,
  clipIds: string[],
): Promise<Map<string, string>> {
  const statuses = new Map<string, string>();
  const unique = [...new Set(clipIds.filter(Boolean))];
  for (let index = 0; index < unique.length; index += 80) {
    const chunk = unique.slice(index, index + 80);
    const { data, error } = await getSupabase()
      .from("clips")
      .select("id, status")
      .eq("user_id", userId)
      .in("id", chunk);
    if (error) throw error;
    for (const row of data ?? []) statuses.set(row.id, row.status);
  }
  return statuses;
}

export async function fetchOwnClips(accessToken: string): Promise<CloudClip[]> {
  const clips: CloudClip[] = [];
  let page = 1;
  const limit = 48;
  let total = Number.POSITIVE_INFINITY;
  while (clips.length < total) {
    const response = await fetch(`${publicApiUrl()}/v1/library?page=${page}&limit=${limit}`, {
      headers: { accept: "application/json", authorization: `Bearer ${accessToken}` },
    });
    const body = await readApiJson<{ clips?: CloudClip[]; total?: number }>(response, "Could not load cloud clips");
    const batch = (body.clips ?? []).map((row) => ({
      id: row.id,
      title: row.title,
      slug: row.slug,
      status: row.status,
      visibility: row.visibility,
      durationMs: row.durationMs,
      width: row.width,
      height: row.height,
      fileSizeBytes: row.fileSizeBytes,
      createdAt: row.createdAt,
      thumbnailUrl: row.thumbnailUrl ?? null,
      playbackUrl: row.playbackUrl ?? null,
    }));
    clips.push(...batch);
    total = Number(body.total) || clips.length;
    if (batch.length < limit) break;
    page += 1;
  }
  return clips;
}

export async function fetchGames(): Promise<CloudGame[]> {
  const { data, error } = await getSupabase()
    .from("games")
    .select("id, slug, name, publisher, cover_url, icon_url, process_names")
    .order("name");
  if (error) throw error;
  return data ?? [];
}
