import type { StaffBoardCard, StaffBoardDetail, StaffTaskDetail } from "../../lib/staff";

export type ColumnTone = "slate" | "blue" | "cyan" | "purple" | "green";

export type BoardFilters = {
  q: string;
  assigneeId: string;
  priority: string;
  labelId: string;
  due: string;
  columnId: string;
};

export const EMPTY_FILTERS: BoardFilters = {
  q: "",
  assigneeId: "",
  priority: "",
  labelId: "",
  due: "",
  columnId: "",
};

const PRIORITY_RANK: Record<string, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
  none: 4,
};

const FAV_KEY = "replayr.staff.board.favorites";

export function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? parts[0]?.[1] ?? ""}`;
  return letters.toUpperCase() || "?";
}

export function columnTone(name: string): ColumnTone {
  const value = name.trim().toLowerCase();
  if (/(done|complete|shipped|closed)/.test(value)) return "green";
  if (/(test|review|qa|approval)/.test(value)) return "purple";
  if (/(progress|doing|active|wip)/.test(value)) return "cyan";
  if (/(confirm|todo|to do|ready|planned)/.test(value)) return "blue";
  return "slate";
}

export function columnIconKind(name: string): ColumnTone {
  return columnTone(name);
}

export function formatDue(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function dueIsOverdue(value: string | null) {
  if (!value) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.getTime() < Date.now() && !Number.isNaN(date.getTime());
}

export function dueIsSoon(value: string | null) {
  if (!value) return false;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  const delta = date.getTime() - Date.now();
  return delta >= 0 && delta <= 7 * 24 * 60 * 60 * 1000;
}

export function priorityRank(priority: string) {
  return PRIORITY_RANK[priority] ?? 5;
}

export function labelTone(name: string, color?: string) {
  if (color) return color;
  const palette = ["#6b8ca8", "#5d9b8a", "#8a7bb8", "#a8885c", "#6a9cc4", "#9a6b7a"];
  let hash = 0;
  for (const char of name) hash = (hash + char.charCodeAt(0)) % palette.length;
  return palette[hash] ?? "#6b8ca8";
}

export function filtersActive(filters: BoardFilters) {
  return Boolean(filters.q || filters.assigneeId || filters.priority || filters.labelId || filters.due || filters.columnId);
}

export function taskMatchesFilters(task: StaffBoardCard, filters: BoardFilters, columnId: string) {
  if (filters.columnId && filters.columnId !== columnId) return false;
  if (filters.priority && task.priority !== filters.priority) return false;
  if (filters.labelId && !task.labelIds.includes(filters.labelId)) return false;
  if (filters.assigneeId === "unassigned" && task.assignees.length) return false;
  if (filters.assigneeId && filters.assigneeId !== "unassigned" && !task.assignees.some((person) => person.id === filters.assigneeId)) {
    return false;
  }
  if (filters.due === "overdue" && !dueIsOverdue(task.dueAt)) return false;
  if (filters.due === "soon" && !dueIsSoon(task.dueAt)) return false;
  if (filters.due === "unset" && task.dueAt) return false;
  if (filters.q) {
    const haystack = `${task.title} ${task.priority} ${task.assignees.map((person) => person.displayName).join(" ")}`.toLowerCase();
    if (!haystack.includes(filters.q.trim().toLowerCase())) return false;
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

export function boardSubtitle(board: StaffBoardDetail | null) {
  if (!board) return "Track, prioritize, and ship.";
  if (board.description?.trim()) return board.description.trim();
  return "Track, prioritize, and ship.";
}

export function readFavoriteIds(): string[] {
  try {
    const raw = localStorage.getItem(FAV_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function writeFavoriteIds(ids: string[]) {
  localStorage.setItem(FAV_KEY, JSON.stringify(ids));
}

export function visibilityLabel(value: string) {
  if (value === "private") return "Private";
  if (value === "role") return "Role";
  return "Staff";
}

export type StaffTaskCardPatch = {
  id: string;
  title?: string;
  priority?: string;
  dueAt?: string | null;
  assignees?: StaffBoardCard["assignees"];
  labelIds?: string[];
  columnId?: string;
};

export function taskFromSnapshot(card: StaffBoardCard, board: StaffBoardDetail | null): StaffTaskDetail {
  return {
    id: card.id,
    boardId: board?.id ?? "",
    columnId: board?.columns.find((column) => column.tasks.some((item) => item.id === card.id))?.id ?? "",
    title: card.title,
    description: null,
    rank: card.rank,
    priority: card.priority,
    dueAt: card.dueAt,
    startedAt: null,
    completedAt: card.completedAt,
    archivedAt: card.archivedAt,
    createdAt: "",
    updatedAt: "",
    boardRole: board?.boardRole ?? "viewer",
    canMutate: Boolean(board?.canMutate),
    watching: false,
    assignees: card.assignees,
    labelIds: card.labelIds,
    checklists: [],
    subtasks: [],
    comments: [],
    attachments: [],
    relations: [],
    activity: [],
  };
}

export function applyCardPatch(board: StaffBoardDetail, patch: StaffTaskCardPatch): StaffBoardDetail {
  const { columnId, ...fields } = patch;
  if (!columnId) {
    return {
      ...board,
      columns: board.columns.map((column) => ({
        ...column,
        tasks: column.tasks.map((task) => (task.id === patch.id ? { ...task, ...fields } : task)),
      })),
    };
  }
  let moving: StaffBoardCard | undefined;
  const columns = board.columns.map((column) => ({
    ...column,
    tasks: column.tasks.filter((task) => {
      if (task.id !== patch.id) return true;
      moving = { ...task, ...fields };
      return column.id === columnId;
    }).map((task) => (task.id === patch.id ? { ...task, ...fields } : task)),
  }));
  if (!moving) return board;
  const card = moving;
  const inTarget = columns.some((column) => column.id === columnId && column.tasks.some((task) => task.id === patch.id));
  if (inTarget) return { ...board, columns };
  return {
    ...board,
    columns: columns.map((column) => (column.id === columnId ? { ...column, tasks: [...column.tasks, card] } : column)),
  };
}

export function applyCardRemove(board: StaffBoardDetail, taskId: string): StaffBoardDetail {
  return {
    ...board,
    columns: board.columns.map((column) => ({
      ...column,
      tasks: column.tasks.filter((task) => task.id !== taskId),
    })),
  };
}
