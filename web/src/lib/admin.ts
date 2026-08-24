import { readApiJson } from "./http";
import { apiUrl } from "./supabase";

export function isAdminUser(user?: { app_metadata?: unknown } | null, accessToken?: string | null): boolean {
  return metaRole(user?.app_metadata) === "admin" || metaRole(jwtAppMetadata(accessToken)) === "admin";
}

export function isAdminSession(session?: { access_token?: string; user?: { app_metadata?: unknown } | null } | null): boolean {
  return isAdminUser(session?.user, session?.access_token);
}

function metaRole(meta: unknown): unknown {
  if (!meta || typeof meta !== "object") return undefined;
  return (meta as { role?: unknown }).role;
}

function jwtAppMetadata(token?: string | null): unknown {
  if (!token) return undefined;
  try {
    const part = token.split(".")[1];
    if (!part) return undefined;
    const padded = part.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(padded)).app_metadata;
  } catch {
    return undefined;
  }
}

export interface AdminOverview {
  users: number;
  active1d: number;
  active7d: number;
  active30d: number;
  readyClips: number;
  clipsToday: number;
  storageUsedBytes: number;
  pendingCreatorApps: number;
  openErrors: number;
  errors24h: number;
}

export interface AdminErrorRow {
  fingerprint: string;
  surface: "desktop" | "web" | "mobile" | "worker";
  level: "error" | "crash";
  message: string;
  stack: string | null;
  release: string | null;
  path: string | null;
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
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
  userId: string;
  ownerEmail: string | null;
  ownerUsername: string | null;
  gameName: string | null;
  gameSlug: string | null;
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
  userId: string;
  displayName: string;
  channelUrl: string;
  game: string | null;
  note: string | null;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
  reviewedAt: string | null;
  reviewNote: string | null;
  email: string | null;
  username: string | null;
}

export interface AdminList<T> {
  total: number;
  page: number;
  limit: number;
  items: T[];
}

async function adminFetch<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("accept", "application/json");
  headers.set("authorization", `Bearer ${token}`);
  if (init?.body) headers.set("content-type", "application/json");
  const response = await fetch(apiUrl(path), { ...init, headers });
  return readApiJson<T>(response, "Admin request failed.");
}

export function fetchAdminOverview(token: string) {
  return adminFetch<AdminOverview>("/v1/admin/overview", token);
}

export function fetchAdminPlans(token: string) {
  return adminFetch<{ plans: AdminPlan[] }>("/v1/admin/plans", token);
}

export async function fetchAdminUsers(
  token: string,
  params: { q?: string; plan?: string; page?: number } = {},
): Promise<AdminList<AdminUserRow>> {
  const query = new URLSearchParams();
  if (params.q) query.set("q", params.q);
  if (params.plan) query.set("plan", params.plan);
  if (params.page) query.set("page", String(params.page));
  const suffix = query.toString() ? `?${query}` : "";
  const body = await adminFetch<{ users: AdminUserRow[]; total: number; page: number; limit: number }>(
    `/v1/admin/users${suffix}`,
    token,
  );
  return { items: body.users, total: body.total, page: body.page, limit: body.limit };
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

export async function fetchAdminClips(
  token: string,
  params: { q?: string; status?: string; visibility?: string; game?: string; page?: number } = {},
): Promise<AdminList<AdminClipRow>> {
  const query = new URLSearchParams();
  if (params.q) query.set("q", params.q);
  if (params.status) query.set("status", params.status);
  if (params.visibility) query.set("visibility", params.visibility);
  if (params.game) query.set("game", params.game);
  if (params.page) query.set("page", String(params.page));
  const suffix = query.toString() ? `?${query}` : "";
  const body = await adminFetch<{ clips: AdminClipRow[]; total: number; page: number; limit: number }>(
    `/v1/admin/clips${suffix}`,
    token,
  );
  return { items: body.clips, total: body.total, page: body.page, limit: body.limit };
}

export function deleteAdminClip(token: string, clipId: string) {
  return adminFetch<{ status: string }>(`/v1/admin/clips/${clipId}`, token, { method: "DELETE" });
}

export function fetchAdminStorage(token: string) {
  return adminFetch<{ accounts: AdminStorageRow[]; approaching: AdminStorageRow[] }>("/v1/admin/storage", token);
}

export function fetchAdminCreators(token: string, status = "pending") {
  const suffix = status ? `?status=${encodeURIComponent(status)}` : "";
  return adminFetch<{ applications: AdminCreatorRow[] }>(`/v1/admin/creators${suffix}`, token);
}

export async function fetchAdminErrors(
  token: string,
  params: { q?: string; surface?: string; level?: string; resolved?: "open" | "all"; page?: number } = {},
): Promise<AdminList<AdminErrorRow>> {
  const query = new URLSearchParams();
  if (params.q) query.set("q", params.q);
  if (params.surface) query.set("surface", params.surface);
  if (params.level) query.set("level", params.level);
  if (params.resolved === "all") query.set("resolved", "all");
  if (params.page) query.set("page", String(params.page));
  const suffix = query.toString() ? `?${query}` : "";
  const body = await adminFetch<{ errors: AdminErrorRow[]; total: number; page: number; limit: number }>(
    `/v1/admin/errors${suffix}`,
    token,
  );
  return { items: body.errors, total: body.total, page: body.page, limit: body.limit };
}

export function resolveAdminError(token: string, fingerprint: string, resolved = true) {
  return adminFetch<{ ok: boolean }>(`/v1/admin/errors/${fingerprint}`, token, {
    method: "PATCH",
    body: JSON.stringify({ resolved }),
  });
}

export function reviewCreatorApplication(token: string, id: string, status: "approved" | "rejected", note?: string) {
  return adminFetch<{ status: string }>(`/v1/admin/creators/${id}/review`, token, {
    method: "POST",
    body: JSON.stringify({ status, note }),
  });
}
