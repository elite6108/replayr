import { useEffect, useState } from "react";
import { useAuth } from "../lib/auth";
import { createStaffTask, fetchStaffBoards, type StaffBoardSummary } from "../lib/staff";

export function CreateInternalTaskButton({
  kind,
  targetId,
  label,
}: {
  kind: "clip" | "user" | "screenshot" | "folder" | "creator_application" | "error_fingerprint" | "url";
  targetId: string;
  label?: string;
}) {
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const [open, setOpen] = useState(false);
  const [boards, setBoards] = useState<StaffBoardSummary[]>([]);
  const [boardId, setBoardId] = useState("");
  const [columnId, setColumnId] = useState("");
  const [columns, setColumns] = useState<Array<{ id: string; name: string }>>([]);
  const [title, setTitle] = useState(label || `${kind} ${targetId.slice(0, 8)}`);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || !token) return;
    void fetchStaffBoards(token)
      .then(async (body) => {
        setBoards(body.boards);
        const first = body.boards[0];
        if (first) {
          setBoardId(first.id);
          const { fetchStaffBoard } = await import("../lib/staff");
          const detail = await fetchStaffBoard(token, first.id);
          setColumns(detail.board.columns.map((column) => ({ id: column.id, name: column.name })));
          setColumnId(detail.board.columns[0]?.id ?? "");
        }
      })
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Could not load boards."));
  }, [open, token]);

  if (!token) return null;

  return (
    <>
      <button type="button" className="button ghost" onClick={() => setOpen(true)}>
        Create internal task
      </button>
      {open ? (
        <div className="staff-modal">
          <form
            className="staff-modal-card"
            onSubmit={(event) => {
              event.preventDefault();
              if (!boardId || !columnId || !title.trim()) return;
              setBusy(true);
              void createStaffTask(token, boardId, {
                columnId,
                title: title.trim(),
                relation: { kind, targetId, label },
              })
                .then(() => setOpen(false))
                .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Could not create task."))
                .finally(() => setBusy(false));
            }}
          >
            <h3>Create internal task</h3>
            {error ? <p className="error">{error}</p> : null}
            <label>
              Title
              <input value={title} onChange={(event) => setTitle(event.target.value)} required />
            </label>
            <label>
              Board
              <select
                value={boardId}
                onChange={(event) => {
                  const id = event.target.value;
                  setBoardId(id);
                  void import("../lib/staff").then(({ fetchStaffBoard }) =>
                    fetchStaffBoard(token, id).then((detail) => {
                      setColumns(detail.board.columns.map((column) => ({ id: column.id, name: column.name })));
                      setColumnId(detail.board.columns[0]?.id ?? "");
                    }),
                  );
                }}
              >
                {boards.map((board) => (
                  <option key={board.id} value={board.id}>
                    {board.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Column
              <select value={columnId} onChange={(event) => setColumnId(event.target.value)}>
                {columns.map((column) => (
                  <option key={column.id} value={column.id}>
                    {column.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="admin-filters">
              <button className="button" type="submit" disabled={busy}>
                Create
              </button>
              <button className="button ghost" type="button" onClick={() => setOpen(false)}>
                Cancel
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </>
  );
}
