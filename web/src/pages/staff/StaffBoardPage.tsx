import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../../lib/auth";
import {
  createStaffBoard,
  createStaffColumn,
  createStaffLabel,
  createStaffTask,
  fetchStaffBoard,
  fetchStaffBoards,
  moveStaffTask,
  patchStaffBoard,
  patchStaffColumn,
  patchStaffTask,
  setStaffAssignees,
  type StaffBoardCard,
  type StaffBoardDetail,
  type StaffBoardSummary,
  useStaffPermissions,
} from "../../lib/staff";
import {
  applyCardPatch,
  boardSubtitle,
  columnTone,
  EMPTY_FILTERS,
  filtersActive,
  formatDue,
  initials,
  labelTone,
  readFavoriteIds,
  sortTasks,
  taskMatchesFilters,
  visibilityLabel,
  writeFavoriteIds,
  type BoardFilters,
  type StaffTaskCardPatch,
} from "./boardUi";
import { AssigneePicker, AvatarStack } from "./AssigneePicker";
import { InlineRename } from "./InlineRename";
import {
  IconCalendar,
  IconCheck,
  IconChevron,
  IconDots,
  IconFilter,
  IconInbox,
  IconPlus,
  IconProgress,
  IconReview,
  IconSearch,
  IconSort,
  IconStar,
  IconStaff,
} from "./opsIcons";
import { StaffTaskDrawer } from "./StaffTaskDrawer";
import { useStaffCardDrag } from "./useStaffCardDrag";

export function StaffBoardPage() {
  const { boardId } = useParams();
  const navigate = useNavigate();
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const { can } = useStaffPermissions();
  const [boards, setBoards] = useState<StaffBoardSummary[]>([]);
  const [board, setBoard] = useState<StaffBoardDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [openSnapshot, setOpenSnapshot] = useState<StaffBoardCard | null>(null);
  const [composer, setComposer] = useState<{ columnId: string; title: string; priority: string; assigneeId: string } | null>(null);
  const [columnDraft, setColumnDraft] = useState("");
  const [addingColumn, setAddingColumn] = useState(false);
  const [filters, setFilters] = useState<BoardFilters>(EMPTY_FILTERS);
  const [sort, setSort] = useState("board");
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<string | null>(null);
  const [favorites, setFavorites] = useState<string[]>(() => readFavoriteIds());
  const kanbanRef = useRef<HTMLDivElement>(null);
  const openTimer = useRef<number | null>(null);

  const loadBoards = useCallback(async () => {
    if (!token) return;
    const body = await fetchStaffBoards(token);
    setBoards(body.boards);
    if (!boardId && body.boards[0]) navigate(`/staff/board/${body.boards[0].id}`, { replace: true });
  }, [token, boardId, navigate]);

  const loadBoard = useCallback(async () => {
    if (!token || !boardId) return;
    const body = await fetchStaffBoard(token, boardId);
    setBoard(body.board);
  }, [token, boardId]);

  useEffect(() => {
    void loadBoards().catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Could not load boards."));
  }, [loadBoards]);

  useEffect(() => {
    void loadBoard().catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Could not load board."));
  }, [loadBoard]);

  useEffect(() => {
    function onFocus() {
      void loadBoard();
    }
    function onVis() {
      if (document.visibilityState === "visible") void loadBoard();
    }
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVis);
    const timer = window.setInterval(() => void loadBoard(), 30_000);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVis);
      window.clearInterval(timer);
    };
  }, [loadBoard]);

  useEffect(() => {
    function onKey(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        setOpenMenu(null);
        setComposer(null);
        setAddingColumn(false);
        setRenameTarget(null);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    return () => {
      if (openTimer.current) window.clearTimeout(openTimer.current);
    };
  }, []);

  async function onDrop(columnId: string, beforeRank: string | null, afterRank: string | null, taskIdValue: string) {
    if (!token) return;
    await moveStaffTask(token, taskIdValue, { columnId, beforeRank, afterRank });
    await loadBoard();
  }

  const liveColumns = board?.columns ?? [];
  const displayed = useMemo(() => {
    return liveColumns.map((column) => {
      const matched = column.tasks.filter((task) => taskMatchesFilters(task, filters, column.id));
      return { ...column, tasks: sort === "board" ? matched : sortTasks(matched, sort) };
    });
  }, [liveColumns, filters, sort]);

  const memberPeople = board?.people?.length ? board.people : (board?.members ?? []).map((member) => ({ id: member.staffId, displayName: member.displayName }));
  const starred = Boolean(board && favorites.includes(board.id));
  const canMutate = Boolean(board?.canMutate);
  const canMove = can("board.cards.move") && canMutate;
  const canCreate = can("board.cards.create") && canMutate;
  const canRenameBoard = can("board.edit") && canMutate;
  const canRenameColumns = can("board.columns.edit") && canMutate;
  const canRenameCards = can("board.cards.edit") && canMutate;
  const canAssign = can("board.cards.assign") && canMutate;
  const drag = useStaffCardDrag(canMove, kanbanRef);

  function toggleFavorite() {
    if (!board) return;
    const next = starred ? favorites.filter((id) => id !== board.id) : [...favorites, board.id];
    setFavorites(next);
    writeFavoriteIds(next);
  }

  async function submitComposer(event?: FormEvent) {
    event?.preventDefault();
    if (!token || !board || !composer || !composer.title.trim()) return;
    try {
      const created = await createStaffTask(token, board.id, {
        columnId: composer.columnId,
        title: composer.title.trim(),
        priority: composer.priority !== "none" ? composer.priority : undefined,
      });
      if (composer.assigneeId && can("board.cards.assign")) {
        await setStaffAssignees(token, created.task.id, [composer.assigneeId]);
      }
      setComposer(null);
      await loadBoard();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create task.");
    }
  }

  function openComposer(columnId: string) {
    setComposer({ columnId, title: "", priority: "none", assigneeId: "" });
    setOpenMenu(null);
  }

  async function renameBoardName(name: string) {
    if (!token || !board) return;
    try {
      const body = await patchStaffBoard(token, board.id, { name });
      setBoard(body.board);
      await loadBoards();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not rename board.");
      await loadBoard();
    }
  }

  async function renameBoardDescription(description: string) {
    if (!token || !board) return;
    try {
      const body = await patchStaffBoard(token, board.id, { description });
      setBoard(body.board);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update description.");
      await loadBoard();
    }
  }

  async function renameColumn(columnId: string, name: string) {
    if (!token) return;
    try {
      await patchStaffColumn(token, columnId, { name });
      await loadBoard();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not rename column.");
      await loadBoard();
    }
  }

  async function renameCard(taskIdValue: string, title: string) {
    if (!token) return;
    applyTaskPatch({ id: taskIdValue, title });
    try {
      await patchStaffTask(token, taskIdValue, { title });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not rename task.");
      await loadBoard();
    }
  }

  function applyTaskPatch(patch: StaffTaskCardPatch) {
    setBoard((current) => (current ? applyCardPatch(current, patch) : current));
  }

  function requestOpen(task: StaffBoardCard) {
    if (renameTarget === `task:${task.id}`) return;
    if (openTimer.current) window.clearTimeout(openTimer.current);
    openTimer.current = window.setTimeout(() => {
      setTaskId(task.id);
      setOpenSnapshot(task);
      openTimer.current = null;
    }, 180);
  }

  function requestRename(id: string) {
    if (openTimer.current) {
      window.clearTimeout(openTimer.current);
      openTimer.current = null;
    }
    setRenameTarget(`task:${id}`);
  }

  async function toggleCardAssignee(task: StaffBoardCard, person: { id: string; displayName: string }) {
    if (!token) return;
    const on = task.assignees.some((item) => item.id === person.id);
    const next = on ? task.assignees.filter((item) => item.id !== person.id) : [...task.assignees, person];
    applyTaskPatch({ id: task.id, assignees: next });
    try {
      await setStaffAssignees(token, task.id, next.map((item) => item.id));
    } catch (caught) {
      applyTaskPatch({ id: task.id, assignees: task.assignees });
      setError(caught instanceof Error ? caught.message : "Could not update assignees.");
    }
  }

  function dropOnColumn(columnId: string, originalTasks: StaffBoardCard[], taskIdValue: string) {
    const last = originalTasks[originalTasks.length - 1];
    void onDrop(columnId, last?.rank ?? null, null, taskIdValue);
  }

  function dropOnCard(columnId: string, originalTasks: StaffBoardCard[], target: StaffBoardCard, taskIdValue: string) {
    if (!taskIdValue || taskIdValue === target.id) return;
    const index = originalTasks.findIndex((item) => item.id === target.id);
    const before = originalTasks[index - 1]?.rank ?? null;
    void onDrop(columnId, before, target.rank, taskIdValue);
  }

  function moveCardLocal(taskIdValue: string, toColumnId: string, beforeTaskId: string | null) {
    setBoard((current) => {
      if (!current) return current;
      let moving: StaffBoardCard | undefined;
      const columns = current.columns.map((column) => ({
        ...column,
        tasks: column.tasks.filter((task) => {
          if (task.id !== taskIdValue) return true;
          moving = task;
          return false;
        }),
      }));
      if (!moving) return current;
      const card = moving;
      return {
        ...current,
        columns: columns.map((column) => {
          if (column.id !== toColumnId) return column;
          if (!beforeTaskId) return { ...column, tasks: [...column.tasks, card] };
          const index = column.tasks.findIndex((task) => task.id === beforeTaskId);
          const tasks = [...column.tasks];
          tasks.splice(index < 0 ? tasks.length : index, 0, card);
          return { ...column, tasks };
        }),
      };
    });
  }

  drag.onDropped.current = (result) => {
    if (!result.target) return;
    const original = (board?.columns ?? []).find((column) => column.id === result.target?.columnId)?.tasks ?? [];
    const before = result.target.beforeTaskId ? original.find((task) => task.id === result.target?.beforeTaskId) : null;
    moveCardLocal(result.taskId, result.target.columnId, result.target.beforeTaskId);
    if (before) dropOnCard(result.target.columnId, original, before, result.taskId);
    else dropOnColumn(result.target.columnId, original, result.taskId);
  };

  return (
    <section className={`ops-board${drag.draggingId ? " is-card-dragging" : ""}`}>
      <header className="ops-toolbar">
        <div className="ops-toolbar-title">
          <p className="ops-eyebrow">Operations</p>
          <div className="ops-title-row">
            {board ? (
              <InlineRename
                value={board.name}
                className="ops-page-title"
                ariaLabel="Board name"
                enabled={canRenameBoard}
                editing={renameTarget === "board"}
                onEditingChange={(open) => setRenameTarget(open ? "board" : null)}
                onSave={renameBoardName}
              />
            ) : (
              <h2 className="ops-page-title">Boards</h2>
            )}
            <BoardPicker
              boards={boards}
              boardId={boardId}
              favorites={favorites}
              open={openMenu === "picker"}
              onToggle={() => setOpenMenu((value) => (value === "picker" ? null : "picker"))}
              onClose={() => setOpenMenu((current) => (current === "picker" ? null : current))}
              onSelect={(id) => {
                setOpenMenu(null);
                navigate(`/staff/board/${id}`);
              }}
              canCreate={can("board.create")}
              onCreate={(name) => {
                if (!token) return;
                void createStaffBoard(token, { name }).then((created) => {
                  setOpenMenu(null);
                  navigate(`/staff/board/${created.board.id}`);
                  return loadBoards();
                });
              }}
            />
            {board ? (
              <button
                type="button"
                className={`ops-icon-btn${starred ? " is-on" : ""}`}
                aria-label={starred ? "Unfavorite board" : "Favorite board"}
                onClick={toggleFavorite}
              >
                <IconStar />
              </button>
            ) : null}
          </div>
          {board ? (
            <InlineRename
              value={board.description ?? ""}
              className="ops-subtitle"
              ariaLabel="Board description"
              placeholder="Add a description"
              enabled={canRenameBoard}
              editing={renameTarget === "description"}
              onEditingChange={(open) => setRenameTarget(open ? "description" : null)}
              onSave={renameBoardDescription}
              allowEmpty
            />
          ) : (
            <p className="ops-subtitle">{boardSubtitle(board)}</p>
          )}
        </div>
        <div className="ops-toolbar-actions">
          <AvatarStack people={memberPeople} />
          <label className="ops-search">
            <IconSearch />
            <input
              value={filters.q}
              onChange={(event) => setFilters((current) => ({ ...current, q: event.target.value }))}
              placeholder="Search tasks"
              aria-label="Search tasks"
            />
          </label>
          <OpsMenu
            id="filter"
            open={openMenu === "filter"}
            onToggle={() => setOpenMenu((value) => (value === "filter" ? null : "filter"))}
            onClose={() => setOpenMenu((current) => (current === "filter" ? null : current))}
            trigger={
              <span className="ops-tool-btn">
                <IconFilter />
                Filter
                {filtersActive(filters) ? <i className="ops-dot" /> : null}
              </span>
            }
          >
            <FilterPanel
              board={board}
              filters={filters}
              onChange={setFilters}
              people={memberPeople}
            />
          </OpsMenu>
          <OpsMenu
            id="sort"
            open={openMenu === "sort"}
            onToggle={() => setOpenMenu((value) => (value === "sort" ? null : "sort"))}
            onClose={() => setOpenMenu((current) => (current === "sort" ? null : current))}
            align="right"
            trigger={
              <span className="ops-tool-btn">
                <IconSort />
                Sort
              </span>
            }
          >
            {[
              ["board", "Board order"],
              ["priority", "Priority"],
              ["due", "Due date"],
              ["title", "Title"],
            ].map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={`ops-menu-item${sort === value ? " is-active" : ""}`}
                onClick={() => {
                  setSort(value);
                  setOpenMenu(null);
                }}
              >
                {label}
              </button>
            ))}
          </OpsMenu>
          <OpsMenu
            id="members"
            open={openMenu === "members"}
            onToggle={() => setOpenMenu((value) => (value === "members" ? null : "members"))}
            onClose={() => setOpenMenu((current) => (current === "members" ? null : current))}
            align="right"
            trigger={
              <span className="ops-tool-btn">
                <IconStaff />
                Members
              </span>
            }
          >
            {memberPeople.length ? (
              memberPeople.map((person) => (
                <button
                  key={person.id}
                  type="button"
                  className="ops-menu-item"
                  onClick={() => {
                    setFilters((current) => ({ ...current, assigneeId: person.id }));
                    setOpenMenu(null);
                  }}
                >
                  <span className="ops-avatar xs">{initials(person.displayName)}</span>
                  {person.displayName}
                </button>
              ))
            ) : (
              <p className="ops-menu-empty">No members on this board.</p>
            )}
          </OpsMenu>
          <OpsMenu
            id="more"
            open={openMenu === "more"}
            onToggle={() => setOpenMenu((value) => (value === "more" ? null : "more"))}
            onClose={() => setOpenMenu((current) => (current === "more" ? null : current))}
            align="right"
            trigger={
              <span className="ops-tool-btn ops-tool-icon" aria-label="More">
                <IconDots />
              </span>
            }
          >
            {canRenameBoard && board ? (
              <button
                type="button"
                className="ops-menu-item"
                onClick={() => {
                  setOpenMenu(null);
                  setRenameTarget("board");
                }}
              >
                Rename board
              </button>
            ) : null}
            {can("board.labels.manage") && board ? (
              <button
                type="button"
                className="ops-menu-item"
                onClick={() => {
                  const name = window.prompt("Label name?");
                  if (!name || !token) return;
                  void createStaffLabel(token, board.id, name, "#7fd0ef").then(() => {
                    setOpenMenu(null);
                    return loadBoard();
                  });
                }}
              >
                Add label
              </button>
            ) : null}
            {can("board.columns.create") && board ? (
              <button
                type="button"
                className="ops-menu-item"
                onClick={() => {
                  setAddingColumn(true);
                  setOpenMenu(null);
                }}
              >
                Add column
              </button>
            ) : null}
            {filtersActive(filters) ? (
              <button type="button" className="ops-menu-item" onClick={() => setFilters(EMPTY_FILTERS)}>
                Clear filters
              </button>
            ) : null}
          </OpsMenu>
          {canCreate && displayed[0] ? (
            <button type="button" className="ops-create" onClick={() => openComposer(displayed[0].id)}>
              <IconPlus />
              Create Task
            </button>
          ) : null}
        </div>
      </header>
      {error ? <p className="ops-error">{error}</p> : null}
      <div
        className="ops-kanban"
        ref={kanbanRef}
        onWheel={(event) => {
          if (!event.shiftKey) return;
          event.currentTarget.scrollLeft += event.deltaY;
          event.preventDefault();
        }}
      >
        {displayed.map((column) => {
          const tone = columnTone(column.name);
          const menuId = `col-${column.id}`;
          return (
            <section
              key={column.id}
              data-ops-column={column.id}
              className={`ops-column tone-${tone}${drag.over?.columnId === column.id ? " is-drop" : ""}`}
            >
              <header className="ops-column-head">
                <span className="ops-column-icon" aria-hidden="true">
                  {tone === "green" ? <IconCheck /> : tone === "purple" ? <IconReview /> : tone === "cyan" ? <IconProgress /> : <IconInbox />}
                </span>
                <h3 className="ops-column-title">
                  <InlineRename
                    value={column.name}
                    ariaLabel={`${column.name} column`}
                    enabled={canRenameColumns}
                    editing={renameTarget === `col:${column.id}`}
                    onEditingChange={(open) => setRenameTarget(open ? `col:${column.id}` : null)}
                    onSave={(name) => renameColumn(column.id, name)}
                  />
                </h3>
                <span className="ops-count">{column.tasks.length}</span>
                <OpsMenu
                  id={menuId}
                  open={openMenu === menuId}
                  onToggle={() => setOpenMenu((value) => (value === menuId ? null : menuId))}
                  onClose={() => setOpenMenu((current) => (current === menuId ? null : current))}
                  align="right"
                  trigger={
                    <span className="ops-icon-btn sm" aria-label={`${column.name} menu`}>
                      <IconDots />
                    </span>
                  }
                >
                  {canRenameColumns ? (
                    <button
                      type="button"
                      className="ops-menu-item"
                      onClick={() => {
                        setOpenMenu(null);
                        setRenameTarget(`col:${column.id}`);
                      }}
                    >
                      Rename
                    </button>
                  ) : null}
                  {canCreate ? (
                    <button type="button" className="ops-menu-item" onClick={() => openComposer(column.id)}>
                      Add task
                    </button>
                  ) : null}
                </OpsMenu>
              </header>
              <div className="ops-column-body">
                {column.tasks.map((task) => {
                  const renaming = renameTarget === `task:${task.id}`;
                  return (
                  <article
                    key={task.id}
                    data-ops-task={task.id}
                    data-ops-column={column.id}
                    className={`ops-card${drag.draggingId === task.id ? " is-dragging" : ""}${drag.over?.beforeTaskId === task.id ? " is-insert-before" : ""}`}
                    onPointerDown={(event) => {
                      if (renaming || !canMove) return;
                      drag.startFromPointer(event, task, column.id);
                    }}
                    onClick={(event) => {
                      if (renaming) return;
                      if (drag.consumeClick()) return;
                      if ((event.target as HTMLElement).closest(".ops-assignee-picker, .ops-rename-input")) return;
                      if ((event.target as HTMLElement).closest(".ops-card-title")) {
                        requestOpen(task);
                        return;
                      }
                      if (openTimer.current) window.clearTimeout(openTimer.current);
                      setTaskId(task.id);
                      setOpenSnapshot(task);
                    }}
                    onKeyDown={(event: KeyboardEvent<HTMLElement>) => {
                      if (event.key === "Enter" || event.key === " ") {
                        if ((event.target as HTMLElement).closest("button, input, textarea, select")) return;
                        event.preventDefault();
                        if (openTimer.current) window.clearTimeout(openTimer.current);
                        setTaskId(task.id);
                        setOpenSnapshot(task);
                      }
                    }}
                    tabIndex={0}
                  >
                    <div className="ops-card-body">
                    <div
                      onClick={(event) => {
                        if (renaming) event.stopPropagation();
                      }}
                      onDoubleClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        if (canRenameCards) requestRename(task.id);
                      }}
                    >
                      <InlineRename
                        value={task.title}
                        className="ops-card-title"
                        ariaLabel="Task title"
                        enabled={canRenameCards}
                        activate="doubleClick"
                        editing={renaming}
                        onEditingChange={(open) => setRenameTarget(open ? `task:${task.id}` : null)}
                        onSave={(title) => renameCard(task.id, title)}
                      />
                    </div>
                    <div className="ops-card-chips">
                      {task.labelIds.map((labelId) => {
                        const label = board?.labels.find((item) => item.id === labelId);
                        if (!label) return null;
                        return (
                          <span key={label.id} className="ops-label" style={{ "--ops-label": labelTone(label.name, label.color) } as CSSProperties}>
                            {label.name}
                          </span>
                        );
                      })}
                      {task.priority !== "none" ? <span className={`ops-prio prio-${task.priority}`}>{task.priority}</span> : null}
                    </div>
                    <div className="ops-card-meta">
                      <AssigneePicker
                        people={memberPeople}
                        selected={task.assignees}
                        enabled={canAssign}
                        onToggle={(person) => void toggleCardAssignee(task, person)}
                      />
                      {task.dueAt ? (
                        <span className={`ops-due${new Date(task.dueAt).getTime() < Date.now() ? " is-overdue" : ""}`}>
                          <IconCalendar />
                          {formatDue(task.dueAt)}
                        </span>
                      ) : (
                        <span />
                      )}
                    </div>
                    </div>
                  </article>
                  );
                })}
                {!column.tasks.length && composer?.columnId !== column.id ? (
                  <div className="ops-empty-col">
                    <p>No tasks here yet</p>
                    {canCreate ? (
                      <button type="button" className="ops-ghost" onClick={() => openComposer(column.id)}>
                        + Add a task
                      </button>
                    ) : null}
                  </div>
                ) : null}
                {composer?.columnId === column.id ? (
                  <form className="ops-composer" onSubmit={submitComposer}>
                    <input
                      autoFocus
                      value={composer.title}
                      onChange={(event) => setComposer({ ...composer, title: event.target.value })}
                      placeholder="Task title"
                      aria-label="Task title"
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          event.preventDefault();
                          setComposer(null);
                        }
                      }}
                    />
                    <div className="ops-composer-row">
                      <select
                        className="ops-select"
                        aria-label="Priority"
                        value={composer.priority}
                        onChange={(event) => setComposer({ ...composer, priority: event.target.value })}
                      >
                        {["none", "low", "medium", "high", "urgent"].map((value) => (
                          <option key={value} value={value}>
                            {value === "none" ? "Priority" : value}
                          </option>
                        ))}
                      </select>
                      <select
                        className="ops-select"
                        aria-label="Assignee"
                        value={composer.assigneeId}
                        onChange={(event) => setComposer({ ...composer, assigneeId: event.target.value })}
                      >
                        <option value="">Assignee</option>
                        {memberPeople.map((person) => (
                          <option key={person.id} value={person.id}>
                            {person.displayName}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="ops-composer-row">
                      <button className="ops-create sm" type="submit">
                        Create
                      </button>
                      <button type="button" className="ops-ghost" onClick={() => setComposer(null)}>
                        Cancel
                      </button>
                    </div>
                  </form>
                ) : null}
              </div>
              {canCreate && composer?.columnId !== column.id ? (
                <button type="button" className="ops-add-card" onClick={() => openComposer(column.id)}>
                  <IconPlus />
                  Add a card
                </button>
              ) : (
                <div className="ops-add-card-spacer" />
              )}
            </section>
          );
        })}
        {can("board.columns.create") && board ? (
          <div className="ops-column ops-column-add">
            {addingColumn ? (
              <form
                className="ops-composer"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!columnDraft.trim() || !token) return;
                  void createStaffColumn(token, board.id, columnDraft.trim()).then(() => {
                    setColumnDraft("");
                    setAddingColumn(false);
                    return loadBoard();
                  });
                }}
              >
                <input
                  autoFocus
                  value={columnDraft}
                  onChange={(event) => setColumnDraft(event.target.value)}
                  placeholder="Column name"
                  aria-label="Column name"
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      setAddingColumn(false);
                      setColumnDraft("");
                    }
                  }}
                />
                <div className="ops-composer-row">
                  <button className="ops-create sm" type="submit">
                    Add
                  </button>
                  <button
                    type="button"
                    className="ops-ghost"
                    onClick={() => {
                      setAddingColumn(false);
                      setColumnDraft("");
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <button type="button" className="ops-add-column" onClick={() => setAddingColumn(true)}>
                <IconPlus />
                Add column
              </button>
            )}
          </div>
        ) : null}
      </div>
      {drag.ghost ? (
        <div
          ref={drag.ghostRef}
          className="ops-card-ghost"
          style={{ width: drag.ghost.width, minHeight: drag.ghost.height }}
        >
          <strong className="ops-card-title">{drag.ghost.title}</strong>
        </div>
      ) : null}
      {taskId ? (
        <StaffTaskDrawer
          taskId={taskId}
          board={board}
          snapshot={openSnapshot?.id === taskId ? openSnapshot : board?.columns.flatMap((column) => column.tasks).find((task) => task.id === taskId) ?? null}
          onTaskChanged={applyTaskPatch}
          onClose={() => {
            setTaskId(null);
            setOpenSnapshot(null);
          }}
        />
      ) : null}
    </section>
  );
}

function OpsMenu({
  id,
  open,
  onToggle,
  onClose,
  trigger,
  children,
  align = "left",
  ariaLabel,
}: {
  id: string;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  trigger: ReactNode;
  children: ReactNode;
  align?: "left" | "right";
  ariaLabel?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function onPointer(event: PointerEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    }
    window.addEventListener("pointerdown", onPointer);
    return () => window.removeEventListener("pointerdown", onPointer);
  }, [open, onClose]);
  return (
    <div className="ops-menu-wrap" ref={ref}>
      <button type="button" className={`ops-menu-trigger${open ? " is-open" : ""}`} aria-label={ariaLabel} aria-expanded={open} aria-haspopup="menu" aria-controls={`menu-${id}`} onClick={onToggle}>
        {trigger}
      </button>
      {open ? (
        <div className={`ops-menu ${align}`} id={`menu-${id}`} role="menu">
          {children}
        </div>
      ) : null}
    </div>
  );
}

function BoardPicker({
  boards,
  boardId,
  favorites,
  open,
  onToggle,
  onClose,
  onSelect,
  canCreate,
  onCreate,
}: {
  boards: StaffBoardSummary[];
  boardId?: string;
  favorites: string[];
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  onSelect: (id: string) => void;
  canCreate: boolean;
  onCreate: (name: string) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const mine = boards.filter((item) => item.mine || favorites.includes(item.id));
  const rest = boards.filter((item) => !mine.some((owned) => owned.id === item.id));
  const groups = [
    { label: "My Boards", items: mine.length ? mine : boards },
    ...(mine.length && rest.length ? [{ label: "Shared", items: rest }] : []),
  ];

  return (
    <OpsMenu
      id="picker"
      open={open}
      ariaLabel="Switch board"
      onToggle={() => {
        setCreating(false);
        onToggle();
      }}
      onClose={onClose}
      trigger={
        <span className="ops-picker-trigger" title="Switch board">
          <IconChevron />
        </span>
      }
    >
      {groups.map((group) => (
        <div key={group.label}>
          <p className="ops-menu-label">{group.label}</p>
          {group.items.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`ops-menu-item ops-board-item${item.id === boardId ? " is-active" : ""}`}
              onClick={() => onSelect(item.id)}
            >
              <span>
                {item.name}
                {favorites.includes(item.id) ? " ★" : ""}
              </span>
              <span className="ops-vis">{visibilityLabel(item.visibility)}</span>
            </button>
          ))}
        </div>
      ))}
      {canCreate ? (
        creating ? (
          <form
            className="ops-picker-create"
            onSubmit={(event) => {
              event.preventDefault();
              if (!name.trim()) return;
              onCreate(name.trim());
              setName("");
              setCreating(false);
            }}
          >
            <input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Board name" aria-label="Board name" />
            <button className="ops-create sm" type="submit">
              Create
            </button>
          </form>
        ) : (
          <button type="button" className="ops-menu-item" onClick={() => setCreating(true)}>
            <IconPlus />
            Create Board
          </button>
        )
      ) : null}
    </OpsMenu>
  );
}

function FilterPanel({
  board,
  filters,
  onChange,
  people,
}: {
  board: StaffBoardDetail | null;
  filters: BoardFilters;
  onChange: (next: BoardFilters) => void;
  people: Array<{ id: string; displayName: string }>;
}) {
  return (
    <div className="ops-filter">
      <label>
        Assignee
        <select className="ops-select" value={filters.assigneeId} onChange={(event) => onChange({ ...filters, assigneeId: event.target.value })}>
          <option value="">Anyone</option>
          <option value="unassigned">Unassigned</option>
          {people.map((person) => (
            <option key={person.id} value={person.id}>
              {person.displayName}
            </option>
          ))}
        </select>
      </label>
      <label>
        Priority
        <select className="ops-select" value={filters.priority} onChange={(event) => onChange({ ...filters, priority: event.target.value })}>
          <option value="">Any</option>
          {["low", "medium", "high", "urgent"].map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </label>
      <label>
        Label
        <select className="ops-select" value={filters.labelId} onChange={(event) => onChange({ ...filters, labelId: event.target.value })}>
          <option value="">Any</option>
          {(board?.labels ?? []).map((label) => (
            <option key={label.id} value={label.id}>
              {label.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Due date
        <select className="ops-select" value={filters.due} onChange={(event) => onChange({ ...filters, due: event.target.value })}>
          <option value="">Any</option>
          <option value="overdue">Overdue</option>
          <option value="soon">Next 7 days</option>
          <option value="unset">No due date</option>
        </select>
      </label>
      <label>
        Status
        <select className="ops-select" value={filters.columnId} onChange={(event) => onChange({ ...filters, columnId: event.target.value })}>
          <option value="">Any column</option>
          {(board?.columns ?? []).map((column) => (
            <option key={column.id} value={column.id}>
              {column.name}
            </option>
          ))}
        </select>
      </label>
      {filtersActive(filters) ? (
        <button type="button" className="ops-ghost" onClick={() => onChange(EMPTY_FILTERS)}>
          Reset
        </button>
      ) : null}
    </div>
  );
}
