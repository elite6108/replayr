import type { Href } from "expo-router";
import { readApiError, readApiJson } from "./http";
import { apiUrl } from "./supabase";

export class StaffApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "StaffApiError";
    this.status = status;
  }
}

export function isStaffForbidden(error: unknown) {
  return error instanceof StaffApiError && error.status === 403;
}

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
  isOwner: boolean;
  canManageMembers: boolean;
  canDelete: boolean;
  createdAt: string;
  updatedAt: string;
  roleIds: string[];
  members: Array<{ staffId: string; boardRole: string; displayName: string }>;
  people: Array<{ id: string; displayName: string }>;
  labels: Array<{ id: string; name: string; color: string }>;
  columns: Array<{ id: string; name: string; rank: string; archived: boolean; tasks: StaffBoardCard[] }>;
};

export type StaffBoardMember = {
  staffId: string;
  displayName: string;
  boardRole: "admin" | "editor" | "viewer";
  isOwner: boolean;
};

export type StaffBoardMemberCandidate = {
  id: string;
  displayName: string;
};

export type StaffBoardMembers = {
  members: StaffBoardMember[];
  candidates: StaffBoardMemberCandidate[];
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

export type StaffMyTask = {
  id: string;
  boardId: string;
  columnId?: string;
  title: string;
  priority: string;
  dueAt: string | null;
  completedAt: string | null;
  updatedAt: string;
};

export function staffHref(): Href {
  return "/staff" as Href;
}

export function staffBoardsHref(): Href {
  return "/staff/boards" as Href;
}

export function staffBoardHref(boardId: string): Href {
  return `/staff/boards/${boardId}` as Href;
}

export function staffTasksHref(): Href {
  return "/staff/tasks" as Href;
}

export function staffTaskHref(taskId: string): Href {
  return `/staff/tasks/${taskId}` as Href;
}

export function staffDeniedHref(): Href {
  return "/staff/denied" as Href;
}

export function staffMembersHref(): Href {
  return "/staff/members" as Href;
}

export function staffRolesHref(): Href {
  return "/staff/roles" as Href;
}

async function staffFetch<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("accept", "application/json");
  headers.set("authorization", `Bearer ${token}`);
  if (init?.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(apiUrl(path), { ...init, headers });
  if (response.status === 403) {
    throw new StaffApiError(await readApiError(response, "Access denied. Staff membership is required."), 403);
  }
  return readApiJson<T>(response, "Staff request failed.");
}

export function fetchStaffMe(token: string) {
  return staffFetch<StaffMe>("/v1/staff/me", token);
}

export function fetchStaffMembers(token: string) {
  return staffFetch<{ members: StaffMember[] }>("/v1/staff/members", token);
}

export function fetchStaffRoles(token: string) {
  return staffFetch<{ roles: StaffRole[] }>("/v1/staff/roles", token);
}

export function fetchStaffBoards(token: string) {
  return staffFetch<{ boards: StaffBoardSummary[] }>("/v1/staff/boards", token);
}

export function fetchStaffBoard(token: string, id: string) {
  return staffFetch<{ board: StaffBoardDetail }>(`/v1/staff/boards/${id}`, token);
}

export function createStaffBoard(
  token: string,
  body: { name: string; description?: string },
) {
  return staffFetch<{ board: StaffBoardDetail }>("/v1/staff/boards", token, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function fetchStaffBoardMembers(token: string, boardId: string) {
  return staffFetch<StaffBoardMembers>(`/v1/staff/boards/${boardId}/members`, token);
}

export function setStaffBoardMemberRole(
  token: string,
  boardId: string,
  staffId: string,
  boardRole: StaffBoardMember["boardRole"],
) {
  return staffFetch<{ member?: StaffBoardMember; ok?: boolean }>(
    `/v1/staff/boards/${boardId}/members/${staffId}`,
    token,
    {
      method: "PUT",
      body: JSON.stringify({ boardRole }),
    },
  );
}

export function removeStaffBoardMember(token: string, boardId: string, staffId: string) {
  return staffFetch<{ ok: boolean }>(`/v1/staff/boards/${boardId}/members/${staffId}`, token, {
    method: "DELETE",
  });
}

export function deleteStaffBoard(token: string, boardId: string, confirmName: string) {
  return staffFetch<{ ok: boolean }>(`/v1/staff/boards/${boardId}`, token, {
    method: "DELETE",
    body: JSON.stringify({ confirmName }),
  });
}

export function fetchStaffTask(token: string, id: string) {
  return staffFetch<{ task: StaffTaskDetail }>(`/v1/staff/tasks/${id}`, token);
}

export function fetchMyStaffTasks(
  token: string,
  params: { filter?: string; q?: string; priority?: string; due?: string; page?: number; limit?: number } = {},
) {
  const query = new URLSearchParams();
  if (params.filter) query.set("filter", params.filter);
  if (params.q) query.set("q", params.q);
  if (params.priority) query.set("priority", params.priority);
  if (params.due) query.set("due", params.due);
  if (params.page) query.set("page", String(params.page));
  query.set("limit", String(params.limit ?? 30));
  return staffFetch<{ tasks: StaffMyTask[]; page: number; limit: number; total: number }>(`/v1/staff/tasks?${query}`, token);
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
  },
) {
  return staffFetch<{ task: { id: string } }>(`/v1/staff/boards/${boardId}/tasks`, token, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function patchStaffTask(token: string, id: string, body: Record<string, unknown>) {
  return staffFetch<{ task: StaffTaskDetail }>(`/v1/staff/tasks/${id}`, token, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export function moveStaffTask(
  token: string,
  taskId: string,
  body: { columnId: string; beforeRank?: string | null; afterRank?: string | null },
) {
  return staffFetch<{ ok?: boolean }>(`/v1/staff/tasks/${taskId}/move`, token, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function archiveStaffTask(token: string, id: string) {
  return staffFetch<{ ok?: boolean }>(`/v1/staff/tasks/${id}`, token, { method: "DELETE" });
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
  return staffFetch<{ watching?: boolean }>(`/v1/staff/tasks/${id}/watch`, token, {
    method: watch ? "POST" : "DELETE",
  });
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

export function fetchStaffAttachmentUrl(token: string, id: string) {
  return staffFetch<{ url: string; filename: string }>(`/v1/staff/attachments/${id}/url`, token);
}
