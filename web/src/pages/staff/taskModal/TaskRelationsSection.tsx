import { IconClip, IconLink } from "../opsIcons";

const KINDS = [
  { id: "clip", label: "Clip" },
  { id: "user", label: "User" },
  { id: "screenshot", label: "Screenshot" },
  { id: "folder", label: "Folder" },
  { id: "creator_application", label: "Creator application" },
  { id: "error_fingerprint", label: "Error fingerprint" },
  { id: "url", label: "URL" },
];

export function TaskRelationsSection({
  relations,
  canEdit,
  onLink,
}: {
  relations: Array<{ id: string; kind: string; label: string | null; targetId: string }>;
  canEdit: boolean;
  onLink: (payload: { kind: string; targetId: string; label: string }) => void;
}) {
  if (!relations.length && !canEdit) return null;

  return (
    <section className="task-modal-card" style={{ gridArea: "rel" }}>
      <header className="task-modal-card-head">
        <IconLink />
        <div>
          <h3>Relations</h3>
          <p>Link this task to a clip, board, or other item.</p>
        </div>
      </header>
      {relations.length ? (
        <ul className="task-modal-relation-list">
          {relations.map((row) => (
            <li key={row.id}>
              <span className="task-modal-kind">{kindLabel(row.kind)}</span>
              <span>{row.label || row.targetId}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {canEdit ? (
        <form
          className="task-modal-relation-form"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            const targetId = String(data.get("targetId") || "").trim();
            if (!targetId) return;
            onLink({
              kind: String(data.get("kind") || "clip"),
              targetId,
              label: "",
            });
            event.currentTarget.reset();
          }}
        >
          <label className="task-modal-kind-select">
            <IconClip />
            <select className="task-modal-input" name="kind" aria-label="Relation type" defaultValue="clip">
              {KINDS.map((kind) => (
                <option key={kind.id} value={kind.id}>
                  {kind.label}
                </option>
              ))}
            </select>
          </label>
          <div className="task-modal-relation-row">
            <input className="task-modal-input" name="targetId" placeholder="Paste clip URL or search…" required />
            <button className="task-modal-link-btn" type="submit">
              Link
            </button>
          </div>
        </form>
      ) : null}
    </section>
  );
}

function kindLabel(kind: string) {
  return KINDS.find((item) => item.id === kind)?.label ?? kind;
}
