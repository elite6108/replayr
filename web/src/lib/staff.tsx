import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { readApiJson } from "./http";
import { apiUrl } from "./supabase";
import { useAuth } from "./auth";

export type StaffPermissionKey = string;

export type StaffMe = {
  staff: {
    id: string;
    userId: string;
    displayName: string;
    email: string | null;
    jobTitle: string | null;
    department: string | null;
    status: string;
  };
  roles: Array<{ id: string; slug: string; name: string; color: string | null; isSystem: boolean; isSuperAdmin: boolean }>;
  permissions: string[];
  isSuperAdmin: boolean;
};

export type StaffMember = {
  id: string;
  userId: string;
  displayName: string;
  username: string | null;
  avatarUrl: string | null;
  jobTitle: string | null;
  department: string | null;
  status: string;
  createdAt: string;
  lastActiveAt: string | null;
  roles: Array<{ id: string; slug: string; name: string; color: string | null; isSystem: boolean; isSuperAdmin: boolean }>;
  permissions: string[];
  isSuperAdmin: boolean;
};

export type StaffRole = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  color: string | null;
  isSystem: boolean;
  isSuperAdmin: boolean;
  memberCount?: number;
  permissions: string[];
};

export type PermissionCatalogItem = {
  key: string;
  category: string;
  label: string;
  description: string | null;
  sort: number;
};

export type StaffBoardSummary = {
  id: string;
  workspaceId: string;
  name: string;
  slug: string;
  description: string | null;
  visibility: string;
  boardRole: string;
  mine: boolean;
  createdAt: string;
  updatedAt: string;
};

export type StaffBoardCard = {
  id: string;
  title: string;
  rank: string;
  priority: string;
  dueAt: string | null;
  completedAt: string | null;
  archivedAt: string | null;
  assignees: Array<{ id: string; displayName: string }>;
  labelIds: string[];
};

export type StaffBoardDetail = {
  id: string;
  workspaceId: string;
  name: string;
  slug: string;
  description: string | null;
  visibility: string;
  boardRole: string;
  canMutate: boolean;
  createdAt: string;
  updatedAt: string;
  roleIds: string[];
  members: Array<{ staffId: string; boardRole: string; displayName: string }>;
  people: Array<{ id: string; displayName: string }>;
  labels: Array<{ id: string; name: string; color: string }>;
  columns: Array<{ id: string; name: string; rank: string; archived: boolean; tasks: StaffBoardCard[] }>;
};

export type StaffTaskDetail = {
  id: string;
  boardId: string;
  columnId: string;
  title: string;
  description: string | null;
  rank: string;
  priority: string;
  dueAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  boardRole: string;
  canMutate: boolean;
  watching: boolean;
  assignees: Array<{ id: string; displayName: string }>;
  labelIds: string[];
  checklists: Array<{
    id: string;
    title: string;
    rank: string;
    items: Array<{ id: string; title: string; done: boolean; rank: string }>;
  }>;
  subtasks: Array<{ id: string; title: string; assigneeStaffId: string | null; done: boolean; rank: string }>;
  comments: Array<{
    id: string;
    parentId: string | null;
    authorStaffId: string | null;
    authorName: string;
    body: string;
    createdAt: string;
  }>;
  attachments: Array<{ id: string; filename: string; mime: string | null; bytes: number | null; createdAt: string }>;
  relations: Array<{ id: string; kind: string; targetId: string; label: string | null }>;
  activity: Array<{ id: string; action: string; metadata: Record<string, unknown>; createdAt: string; actorStaffId: string | null }>;
};

async function staffFetch<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("accept", "application/json");
  headers.set("authorization", `Bearer ${token}`);
  if (init?.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(apiUrl(path), { ...init, headers });
  return readApiJson<T>(response, "Staff request failed.");
}

export function fetchStaffMe(token: string) {
  return staffFetch<StaffMe>("/v1/staff/me", token);
}

export function fetchStaffMembers(token: string) {
  return staffFetch<{ members: StaffMember[] }>("/v1/staff/members", token);
}

export function fetchStaffMember(token: string, id: string) {
  return staffFetch<{ member: StaffMember }>(`/v1/staff/members/${id}`, token);
}

export function patchStaffMember(token: string, id: string, body: { displayName?: string; jobTitle?: string | null; department?: string | null }) {
  return staffFetch<{ member: StaffMember }>(`/v1/staff/members/${id}`, token, { method: "PATCH", body: JSON.stringify(body) });
}

export function setStaffMemberStatus(token: string, id: string, action: "suspend" | "activate" | "deactivate") {
  return staffFetch<{ member: StaffMember }>(`/v1/staff/members/${id}/${action}`, token, { method: "POST", body: "{}" });
}

export function assignStaffRoles(token: string, id: string, roleIds: string[]) {
  return staffFetch<{ member: StaffMember }>(`/v1/staff/members/${id}/roles`, token, {
    method: "PUT",
    body: JSON.stringify({ roleIds }),
  });
}

export function fetchStaffRoles(token: string) {
  return staffFetch<{ roles: StaffRole[]; catalog: PermissionCatalogItem[] }>("/v1/staff/roles", token);
}

export function createStaffRole(token: string, body: { name: string; description?: string; color?: string; permissions: string[] }) {
  return staffFetch<{ role: StaffRole }>("/v1/staff/roles", token, { method: "POST", body: JSON.stringify(body) });
}

export function patchStaffRole(token: string, id: string, body: { name?: string; description?: string | null; color?: string | null; permissions?: string[] }) {
  return staffFetch<{ role: StaffRole }>(`/v1/staff/roles/${id}`, token, { method: "PATCH", body: JSON.stringify(body) });
}

export function duplicateStaffRole(token: string, id: string) {
  return staffFetch<{ role: StaffRole }>(`/v1/staff/roles/${id}/duplicate`, token, { method: "POST", body: "{}" });
}

export function deleteStaffRole(token: string, id: string, body: { reassignTo?: string; clearAssignments?: boolean }) {
  return staffFetch<{ ok: boolean }>(`/v1/staff/roles/${id}`, token, { method: "DELETE", body: JSON.stringify(body) });
}

export function fetchStaffInvites(token: string) {
  return staffFetch<{
    invites: Array<{
      id: string;
      email: string;
      displayName: string | null;
      status: string;
      expiresAt: string;
      roles: Array<{ id: string; name: string; slug: string }>;
    }>;
  }>("/v1/staff/invites", token);
}

export function createStaffInvite(token: string, body: { email: string; displayName?: string; jobTitle?: string; department?: string; roleIds: string[] }) {
  return staffFetch<{ invite: { id: string } }>("/v1/staff/invites", token, { method: "POST", body: JSON.stringify(body) });
}

export function revokeStaffInvite(token: string, id: string) {
  return staffFetch<{ ok: boolean }>(`/v1/staff/invites/${id}/revoke`, token, { method: "POST", body: "{}" });
}

export function fetchStaffBoards(token: string) {
  return staffFetch<{ boards: StaffBoardSummary[] }>("/v1/staff/boards", token);
}

export function fetchStaffBoard(token: string, id: string) {
  return staffFetch<{ board: StaffBoardDetail }>(`/v1/staff/boards/${id}`, token);
}

export function createStaffBoard(token: string, body: { name: string; description?: string; visibility?: string }) {
  return staffFetch<{ board: StaffBoardDetail }>("/v1/staff/boards", token, { method: "POST", body: JSON.stringify(body) });
}

export function patchStaffBoard(token: string, id: string, body: Record<string, unknown>) {
  return staffFetch<{ board: StaffBoardDetail }>(`/v1/staff/boards/${id}`, token, { method: "PATCH", body: JSON.stringify(body) });
}

export function createStaffColumn(token: string, boardId: string, name: string) {
  return staffFetch(`/v1/staff/boards/${boardId}/columns`, token, { method: "POST", body: JSON.stringify({ name }) });
}

export function patchStaffColumn(token: string, columnId: string, body: { name?: string; beforeRank?: string | null; afterRank?: string | null }) {
  return staffFetch<{ ok: boolean }>(`/v1/staff/columns/${columnId}`, token, { method: "PATCH", body: JSON.stringify(body) });
}

export function createStaffLabel(token: string, boardId: string, name: string, color: string) {
  return staffFetch(`/v1/staff/boards/${boardId}/labels`, token, { method: "POST", body: JSON.stringify({ name, color }) });
}

export function createStaffTask(
  token: string,
  boardId: string,
  body: {
    columnId: string;
    title: string;
    description?: string;
    priority?: string;
    dueAt?: string | null;
    relation?: { kind: string; targetId: string; label?: string };
  },
) {
  return staffFetch<{ task: { id: string } }>(`/v1/staff/boards/${boardId}/tasks`, token, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function moveStaffTask(token: string, taskId: string, body: { columnId: string; beforeRank?: string | null; afterRank?: string | null }) {
  return staffFetch(`/v1/staff/tasks/${taskId}/move`, token, { method: "POST", body: JSON.stringify(body) });
}

export function fetchStaffTask(token: string, id: string) {
  return staffFetch<{ task: StaffTaskDetail }>(`/v1/staff/tasks/${id}`, token);
}

export function patchStaffTask(token: string, id: string, body: Record<string, unknown>) {
  return staffFetch<{ task: StaffTaskDetail }>(`/v1/staff/tasks/${id}`, token, { method: "PATCH", body: JSON.stringify(body) });
}

export function archiveStaffTask(token: string, id: string) {
  return staffFetch(`/v1/staff/tasks/${id}`, token, { method: "DELETE" });
}

export function setStaffAssignees(token: string, id: string, staffIds: string[]) {
  return staffFetch<{ task: StaffTaskDetail }>(`/v1/staff/tasks/${id}/assignees`, token, {
    method: "PUT",
    body: JSON.stringify({ staffIds }),
  });
}

export function setStaffTaskLabels(token: string, id: string, labelIds: string[]) {
  return staffFetch<{ task: StaffTaskDetail }>(`/v1/staff/tasks/${id}/labels`, token, {
    method: "PUT",
    body: JSON.stringify({ labelIds }),
  });
}

export function watchStaffTask(token: string, id: string, watch: boolean) {
  return staffFetch(`/v1/staff/tasks/${id}/watch`, token, { method: watch ? "POST" : "DELETE" });
}

export function commentStaffTask(token: string, id: string, body: string, parentId?: string | null) {
  return staffFetch<{ task: StaffTaskDetail }>(`/v1/staff/tasks/${id}/comments`, token, {
    method: "POST",
    body: JSON.stringify({ body, parentId }),
  });
}

export function addStaffChecklist(token: string, id: string, title: string) {
  return staffFetch<{ task: StaffTaskDetail }>(`/v1/staff/tasks/${id}/checklists`, token, {
    method: "POST",
    body: JSON.stringify({ title }),
  });
}

export function addStaffChecklistItem(token: string, checklistId: string, title: string) {
  return staffFetch<{ task: StaffTaskDetail }>(`/v1/staff/checklists/${checklistId}/items`, token, {
    method: "POST",
    body: JSON.stringify({ title }),
  });
}

export function patchStaffChecklistItem(token: string, itemId: string, body: { title?: string; done?: boolean }) {
  return staffFetch<{ task: StaffTaskDetail }>(`/v1/staff/checklist-items/${itemId}`, token, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export function addStaffSubtask(token: string, id: string, title: string) {
  return staffFetch<{ task: StaffTaskDetail }>(`/v1/staff/tasks/${id}/subtasks`, token, {
    method: "POST",
    body: JSON.stringify({ title }),
  });
}

export function patchStaffSubtask(token: string, id: string, body: { title?: string; done?: boolean }) {
  return staffFetch<{ task: StaffTaskDetail }>(`/v1/staff/subtasks/${id}`, token, { method: "PATCH", body: JSON.stringify(body) });
}

export function addStaffRelation(token: string, id: string, body: { kind: string; targetId: string; label?: string }) {
  return staffFetch<{ task: StaffTaskDetail }>(`/v1/staff/tasks/${id}/relations`, token, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function uploadStaffAttachment(token: string, taskId: string, file: File) {
  return staffFetch<{ attachment: { id: string }; uploadUrl: string }>(`/v1/staff/tasks/${taskId}/attachments`, token, {
    method: "POST",
    body: JSON.stringify({ filename: file.name, mime: file.type || "application/octet-stream", bytes: file.size }),
  }).then(async (created) => {
    const put = await fetch(created.uploadUrl, { method: "PUT", body: file, headers: { "content-type": file.type || "application/octet-stream" } });
    if (!put.ok) throw new Error("Could not upload the attachment.");
    return created;
  });
}

export function fetchStaffAttachmentUrl(token: string, id: string) {
  return staffFetch<{ url: string; filename: string }>(`/v1/staff/attachments/${id}/url`, token);
}

export function fetchMyStaffTasks(token: string, params: { filter?: string; q?: string; priority?: string; due?: string; page?: number } = {}) {
  const query = new URLSearchParams();
  if (params.filter) query.set("filter", params.filter);
  if (params.q) query.set("q", params.q);
  if (params.priority) query.set("priority", params.priority);
  if (params.due) query.set("due", params.due);
  if (params.page) query.set("page", String(params.page));
  const suffix = query.toString() ? `?${query}` : "";
  return staffFetch<{ tasks: Array<{ id: string; boardId: string; title: string; priority: string; dueAt: string | null; updatedAt: string }>; page: number; limit: number }>(
    `/v1/staff/tasks${suffix}`,
    token,
  );
}

type StaffContextValue = {
  me: StaffMe | null;
  loading: boolean;
  denied: boolean;
  can: (key: StaffPermissionKey) => boolean;
  canAny: (...keys: StaffPermissionKey[]) => boolean;
  reload: () => void;
};

const StaffContext = createContext<StaffContextValue>({
  me: null,
  loading: false,
  denied: false,
  can: () => false,
  canAny: () => false,
  reload: () => undefined,
});

export function StaffPermissionsProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const token = session?.access_token;
  const [me, setMe] = useState<StaffMe | null>(null);
  const [loading, setLoading] = useState(Boolean(token));
  const [denied, setDenied] = useState(false);

  function load() {
    if (!token) {
      setMe(null);
      setDenied(false);
      setLoading(false);
      return;
    }
    setLoading(true);
    void fetchStaffMe(token)
      .then((next) => {
        setMe(next);
        setDenied(false);
      })
      .catch(() => {
        setMe(null);
        setDenied(true);
      })
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const value = useMemo<StaffContextValue>(() => {
    const permissions = new Set(me?.permissions ?? []);
    const all = Boolean(me?.isSuperAdmin || permissions.has("*"));
    const can = (key: StaffPermissionKey) => all || permissions.has(key);
    return {
      me,
      loading,
      denied,
      can,
      canAny: (...keys) => keys.some((key) => can(key)),
      reload: load,
    };
  }, [me, loading, denied, token]);

  return <StaffContext.Provider value={value}>{children}</StaffContext.Provider>;
}

export function useStaffPermissions() {
  return useContext(StaffContext);
}
