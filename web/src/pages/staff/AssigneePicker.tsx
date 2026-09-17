import { useEffect, useMemo, useRef, useState } from "react";
import { initials } from "./boardUi";
import { IconPlus } from "./opsIcons";

export type AssigneePerson = { id: string; displayName: string };

export function AvatarStack({
  people,
  plus,
}: {
  people: AssigneePerson[];
  plus?: boolean;
}) {
  const shown = people.slice(0, 3);
  const extra = people.length - shown.length;
  if (!people.length && !plus) return <span className="ops-avatars empty" />;
  return (
    <span className="ops-avatars" aria-hidden={plus ? undefined : true} aria-label={people.map((person) => person.displayName).join(", ") || undefined}>
      {shown.map((person) => (
        <span key={person.id} className="ops-avatar" title={person.displayName}>
          {initials(person.displayName)}
        </span>
      ))}
      {extra > 0 ? <span className="ops-avatar more">+{extra}</span> : null}
      {plus ? (
        <span className="ops-avatar plus" title="Assign">
          <IconPlus width="10" height="10" />
        </span>
      ) : null}
    </span>
  );
}

export function AssigneePicker({
  people,
  selected,
  onToggle,
  enabled,
  align = "left",
}: {
  people: AssigneePerson[];
  selected: AssigneePerson[];
  onToggle: (person: AssigneePerson) => void;
  enabled: boolean;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const showSearch = people.length > 8;
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return people;
    return people.filter((person) => person.displayName.toLowerCase().includes(needle));
  }, [people, query]);

  useEffect(() => {
    if (!open) return;
    function onPointer(event: PointerEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!enabled) {
    return selected.length ? <AvatarStack people={selected} /> : <span className="muted">Unassigned</span>;
  }

  return (
    <div className="ops-menu-wrap ops-assignee-picker" ref={ref}>
      <button
        type="button"
        className={`ops-assignee-trigger${open ? " is-open" : ""}`}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label="Assignees"
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
          setQuery("");
        }}
      >
        <AvatarStack people={selected} plus />
      </button>
      {open ? (
        <div className={`ops-menu ${align}`} role="listbox" aria-label="Assign people" onClick={(event) => event.stopPropagation()}>
          {showSearch ? (
            <input
              className="ops-assignee-search"
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search people"
              aria-label="Search people"
            />
          ) : null}
          {filtered.length ? (
            filtered.map((person) => {
              const on = selected.some((item) => item.id === person.id);
              return (
                <button
                  key={person.id}
                  type="button"
                  role="option"
                  aria-selected={on}
                  className={`ops-menu-item${on ? " is-active" : ""}`}
                  onClick={() => onToggle(person)}
                >
                  <span className="ops-avatar xs">{initials(person.displayName)}</span>
                  <span className="ops-assignee-name">{person.displayName}</span>
                  {on ? <span className="ops-assignee-check">✓</span> : null}
                </button>
              );
            })
          ) : (
            <p className="ops-menu-empty">No matches</p>
          )}
        </div>
      ) : null}
    </div>
  );
}
