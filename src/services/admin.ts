import { publicApiUrl } from "../branding";

export interface AdminOverview {
  users: number;
  active1d: number;
  active7d: number;
  active30d: number;
  readyClips: number;
  clipsToday: number;
  storageUsedBytes: number;
  pendingCreatorApps: number;
}

export interface AdminPlan {
  slug: string;
  storageLimitBytes: number;
}

export interface AdminUserRow {
  id: string;
  email: string | null;
  username: string | null;
  displayName: string | null;
  planSlug: string;
  storageUsedBytes: number;
  storageLimitBytes: number;
  clipCount: number;
  lastSignInAt: string | null;
  createdAt: string | null;
  isVerified: boolean;
  role: string | null;
}

export interface AdminClipRow {
  id: string;
  slug: string;
  title: string | null;
  status: string;
  visibility: string;
  fileSizeBytes: number | null;
  durationMs: number | null;
  createdAt: string;
  ownerEmail: string | null;
  ownerUsername: string | null;
  gameName: string | null;
  sharePath: string;
}

export interface AdminStorageRow {
  userId: string;
  email: string | null;
  username: string | null;
  planSlug: string;
  storageUsedBytes: number;
  storageLimitBytes: number;
  percent: number;
  clipCount: number;
}

export interface AdminCreatorRow {
  id: string;
  displayName: string;
  channelUrl: string;
  game: string | null;
  note: string | null;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
  email: string | null;
  username: string | null;
}

async function adminFetch<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("accept", "application/json");
  headers.set("authorization", `Bearer ${token}`);
  if (init?.body) headers.set("content-type", "application/json");
  const response = await fetch(`${publicApiUrl()}${path}`, { ...init, headers });
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || "Admin request failed.");
  return body;
}

export function fetchAdminOverview(token: string) {
  return adminFetch<AdminOverview>("/v1/admin/overview", token);
}

export function fetchAdminPlans(token: string) {
  return adminFetch<{ plans: AdminPlan[] }>("/v1/admin/plans", token);
}

export function fetchAdminUsers(token: string, params: { q?: string; plan?: string } = {}) {
  const query = new URLSearchParams();
  if (params.q) query.set("q", params.q);
  if (params.plan) query.set("plan", params.plan);
  const suffix = query.toString() ? `?${query}` : "";
  return adminFetch<{ users: AdminUserRow[]; total: number }>(`/v1/admin/users${suffix}`, token);
}

export function updateAdminUser(
  token: string,
  userId: string,
  patch: { planSlug?: string; storageLimitBytes?: number },
) {
  return adminFetch<{ ok: boolean }>(`/v1/admin/users/${userId}`, token, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function fetchAdminClips(
  token: string,
  params: { q?: string; status?: string; visibility?: string } = {},
) {
  const query = new URLSearchParams();
  if (params.q) query.set("q", params.q);
  if (params.status) query.set("status", params.status);
  if (params.visibility) query.set("visibility", params.visibility);
  const suffix = query.toString() ? `?${query}` : "";
  return adminFetch<{ clips: AdminClipRow[]; total: number }>(`/v1/admin/clips${suffix}`, token);
}

export function deleteAdminClip(token: string, clipId: string) {
  return adminFetch<{ status: string }>(`/v1/admin/clips/${clipId}`, token, { method: "DELETE" });
}

export function fetchAdminStorage(token: string) {
  return adminFetch<{ accounts: AdminStorageRow[]; approaching: AdminStorageRow[] }>("/v1/admin/storage", token);
}

export function fetchAdminCreators(token: string, status = "pending") {
  return adminFetch<{ applications: AdminCreatorRow[] }>(
    `/v1/admin/creators?status=${encodeURIComponent(status)}`,
    token,
  );
}

export function reviewCreatorApplication(token: string, id: string, status: "approved" | "rejected") {
  return adminFetch<{ status: string }>(`/v1/admin/creators/${id}/review`, token, {
    method: "POST",
    body: JSON.stringify({ status }),
  });
}
