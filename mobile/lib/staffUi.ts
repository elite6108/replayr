import type { StaffBoardCard, StaffBoardDetail, StaffMyTask } from "./api.staff";

export type BoardFilters = {
  q: string;
  assigneeId: string;
  priority: string;
  labelId: string;
  due: string;
};

export const EMPTY_BOARD_FILTERS: BoardFilters = {
  q: "",
  assigneeId: "",
  priority: "",
  labelId: "",
  due: "",
};

const PRIORITY_RANK: Record<string, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
  none: 4,
};

export const PRIORITIES = ["none", "low", "medium", "high", "urgent"] as const;

export function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? parts[0]?.[1] ?? ""}`;
  return letters.toUpperCase() || "?";
}

export function formatDue(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function dueIsOverdue(value: string | null, completedAt?: string | null) {
  if (!value || completedAt) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.getTime() < Date.now();
}

export function dueIsSoon(value: string | null) {
  if (!value) return false;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  const delta = date.getTime() - Date.now();
  return delta >= 0 && delta <= 7 * 24 * 60 * 60 * 1000;
}

export function startOfDay(value = new Date()) {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

export function dueIsToday(value: string | null) {
  if (!value) return false;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  const today = startOfDay();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return date >= today && date < tomorrow;
}

export function priorityRank(priority: string) {
  return PRIORITY_RANK[priority] ?? 5;
}

export function boardSubtitle(board: StaffBoardDetail | null) {
  if (board?.description?.trim()) return board.description.trim();
  return "Track, prioritize, and ship.";
}

export function visibilityLabel(value: string) {
  if (value === "private") return "Private";
  if (value === "role") return "Role";
  return "Staff";
}

export function filtersActive(filters: BoardFilters) {
  return Boolean(filters.q || filters.assigneeId || filters.priority || filters.labelId || filters.due);
}

export function activeFilterCount(filters: BoardFilters) {
  return [filters.q, filters.assigneeId, filters.priority, filters.labelId, filters.due].filter(Boolean).length;
}

export function taskMatchesFilters(
  task: StaffBoardCard,
  filters: BoardFilters,
  labels: StaffBoardDetail["labels"],
) {
  if (filters.priority && task.priority !== filters.priority) return false;
  if (filters.labelId && !task.labelIds.includes(filters.labelId)) return false;
  if (filters.assigneeId === "unassigned" && task.assignees.length) return false;
  if (filters.assigneeId && filters.assigneeId !== "unassigned" && !task.assignees.some((person) => person.id === filters.assigneeId)) {
    return false;
  }
  if (filters.due === "overdue" && !dueIsOverdue(task.dueAt, task.completedAt)) return false;
  if (filters.due === "soon" && !dueIsSoon(task.dueAt)) return false;
  if (filters.due === "unset" && task.dueAt) return false;
  if (filters.q) {
    const needle = filters.q.trim().toLowerCase();
    const labelNames = task.labelIds
      .map((id) => labels.find((label) => label.id === id)?.name ?? "")
      .join(" ");
    const haystack = `${task.title} ${task.id} ${labelNames}`.toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

export function sortTasks(tasks: StaffBoardCard[], sort: string) {
  const copy = [...tasks];
  if (sort === "priority") copy.sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || a.title.localeCompare(b.title));
  if (sort === "due") {
    copy.sort((a, b) => {
      if (!a.dueAt && !b.dueAt) return 0;
      if (!a.dueAt) return 1;
      if (!b.dueAt) return -1;
      return new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime();
    });
  }
  if (sort === "title") copy.sort((a, b) => a.title.localeCompare(b.title));
  return copy;
}

export type MyTaskGroup = "Overdue" | "Today" | "Upcoming" | "No due" | "Completed";

export const MY_TASK_GROUPS: MyTaskGroup[] = ["Overdue", "Today", "Upcoming", "No due", "Completed"];

export function groupMyTasks(tasks: StaffMyTask[]) {
  const groups: Record<MyTaskGroup, StaffMyTask[]> = {
    Overdue: [],
    Today: [],
    Upcoming: [],
    "No due": [],
    Completed: [],
  };
  const today = startOfDay();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  for (const task of tasks) {
    if (task.completedAt) {
      groups.Completed.push(task);
      continue;
    }
    if (!task.dueAt) {
      groups["No due"].push(task);
      continue;
    }
    const due = new Date(task.dueAt);
    if (Number.isNaN(due.getTime())) {
      groups["No due"].push(task);
      continue;
    }
    if (due < today) groups.Overdue.push(task);
    else if (due < tomorrow) groups.Today.push(task);
    else groups.Upcoming.push(task);
  }
  return groups;
}

const CLIP_SLUG = /^[a-z0-9]{6,16}$/i;
const SHOT_SLUG = /^[a-km-z2-9]{12}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function relationHref(kind: string, targetId: string, label: string | null): string | null {
  if (kind === "folder" && UUID.test(targetId)) return `/folders/${targetId}`;
  if (kind === "url" && /^https?:\/\//i.test(targetId)) return targetId;
  if (kind === "url" && label && /^https?:\/\//i.test(label)) return label;
  if (kind === "clip") {
    if (CLIP_SLUG.test(targetId)) return `/c/${targetId}`;
    if (label && CLIP_SLUG.test(label)) return `/c/${label}`;
    return null;
  }
  if (kind === "screenshot") {
    const slug = SHOT_SLUG.test(targetId) ? targetId.toLowerCase() : label && SHOT_SLUG.test(label) ? label.toLowerCase() : null;
    return slug ? `/s/${slug}` : null;
  }
  if (kind === "user") {
    if (label && !UUID.test(label)) return `/u/${label.replace(/^@/, "")}`;
    if (!UUID.test(targetId)) return `/u/${targetId.replace(/^@/, "")}`;
    return null;
  }
  return null;
}

export function dueInputValue(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function parseDueInput(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return undefined;
  const date = new Date(`${match[1]}-${match[2]}-${match[3]}T12:00:00`);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}
