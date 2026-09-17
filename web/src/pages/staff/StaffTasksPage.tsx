import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../lib/auth";
import { fetchMyStaffTasks } from "../../lib/staff";
import { StaffTaskDrawer } from "./StaffTaskDrawer";

export function StaffTasksPage() {
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const navigate = useNavigate();
  const [filter, setFilter] = useState("assigned");
  const [q, setQ] = useState("");
  const [priority, setPriority] = useState("");
  const [due, setDue] = useState("");
  const [tasks, setTasks] = useState<Array<{ id: string; boardId: string; title: string; priority: string; dueAt: string | null; updatedAt: string }>>([]);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    if (!token) return;
    try {
      const body = await fetchMyStaffTasks(token, { filter, q: q || undefined, priority: priority || undefined, due: due || undefined });
      setTasks(body.tasks);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load tasks.");
    }
  }

  useEffect(() => {
    void load();
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    const timer = window.setInterval(() => void load(), 30_000);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, filter, priority, due]);

  return (
    <section className="ops-board ops-tasks">
      <header className="ops-toolbar">
        <div className="ops-toolbar-title">
          <p className="ops-eyebrow">Operations</p>
          <h2 className="ops-page-title">My Tasks</h2>
          <p className="ops-subtitle">Assigned, watching, or created by you.</p>
        </div>
        <form
          className="ops-toolbar-actions"
          onSubmit={(event) => {
            event.preventDefault();
            void load();
          }}
        >
          <select className="ops-select" value={filter} onChange={(event) => setFilter(event.target.value)} aria-label="Task filter">
            <option value="assigned">Assigned to me</option>
            <option value="watching">Watching</option>
            <option value="created">Created by me</option>
          </select>
          <select className="ops-select" value={priority} onChange={(event) => setPriority(event.target.value)} aria-label="Priority">
            <option value="">Any priority</option>
            {["low", "medium", "high", "urgent"].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
          <select className="ops-select" value={due} onChange={(event) => setDue(event.target.value)} aria-label="Due date">
            <option value="">Any due date</option>
            <option value="overdue">Overdue</option>
          </select>
          <label className="ops-search">
            <input value={q} onChange={(event) => setQ(event.target.value)} placeholder="Search tasks" aria-label="Search tasks" />
          </label>
          <button className="ops-tool-btn" type="submit">
            Search
          </button>
        </form>
      </header>
      {error ? <p className="ops-error">{error}</p> : null}
      <ul className="ops-task-list">
        {tasks.map((task) => (
          <li key={task.id}>
            <button type="button" className="ops-task-link" onClick={() => setTaskId(task.id)}>
              {task.title}
            </button>
            {task.priority !== "none" ? <span className={`ops-prio prio-${task.priority}`}>{task.priority}</span> : null}
            <span className="ops-due">{task.dueAt ? `Due ${new Date(task.dueAt).toLocaleDateString()}` : ""}</span>
            <button type="button" className="ops-ghost" onClick={() => navigate(`/staff/board/${task.boardId}`)}>
              Board
            </button>
          </li>
        ))}
        {!tasks.length ? <li className="ops-empty-col">No tasks here yet</li> : null}
      </ul>
      {taskId ? <StaffTaskDrawer taskId={taskId} board={null} onClose={() => setTaskId(null)} /> : null}
    </section>
  );
}
