import { IconPlus } from "../opsIcons";

const KINDS = ["clip", "user", "screenshot", "folder", "creator_application", "error_fingerprint", "url"];

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
    <section className="task-modal-field">
      <label className="task-modal-label">
        Relations <span className="task-modal-info" title="Link a clip, video, matchup or other item to this task.">
          i
        </span>
      </label>
      {relations.length ? (
        <ul className="task-modal-relation-list">
          {relations.map((row) => (
            <li key={row.id}>
              <span className="task-modal-kind">{row.kind}</span>
              <span>{row.label || row.targetId}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {canEdit ? (
        <>
          <form
            className="task-modal-relation-form"
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              onLink({
                kind: String(data.get("kind")),
                targetId: String(data.get("targetId")),
                label: String(data.get("label") || ""),
              });
              event.currentTarget.reset();
            }}
          >
            <select className="task-modal-input" name="kind" aria-label="Relation type">
              {KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {kind}
                </option>
              ))}
            </select>
            <div className="task-modal-relation-row">
              <input className="task-modal-input" name="targetId" placeholder="ID or URL" required />
              <input className="task-modal-input" name="label" placeholder="Label (optional)" />
              <button className="task-modal-link-btn" type="submit">
                Link
              </button>
            </div>
          </form>
          <button
            type="button"
            className="task-modal-add-relation"
            onClick={(event) => {
              const form = event.currentTarget.previousElementSibling;
              const input = form instanceof HTMLFormElement ? form.querySelector<HTMLInputElement>('input[name="targetId"]') : null;
              input?.focus();
            }}
          >
            <IconPlus width="14" height="14" /> Add another relation
          </button>
          <p className="task-modal-hint">Link a clip, video, matchup or other item to this task.</p>
        </>
      ) : null}
    </section>
  );
}
