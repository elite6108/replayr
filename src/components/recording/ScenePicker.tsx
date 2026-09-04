import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { RecordingScene, ScenePresetId } from "../../recording/scene";
import { nextSceneName } from "../../recording/sceneLibrary";
import { ContextMenu } from "../common/ContextMenu";
import { IconCheck, IconChevron, IconMore, IconPlus } from "../icons";

const TEMPLATES: { id: ScenePresetId | ""; label: string }[] = [
  { id: "", label: "Blank" },
  { id: "gameplay", label: "Gameplay" },
  { id: "gameplayWebcam", label: "Gameplay + Webcam" },
  { id: "desktop", label: "Desktop" },
];

export function ScenePicker({
  scenes,
  activeId,
  locked,
  onSelect,
  onCreate,
  onRename,
  onDuplicate,
  onDelete,
}: {
  scenes: RecordingScene[];
  activeId: string;
  locked: boolean;
  onSelect: (id: string) => void;
  onCreate: (name: string, template: ScenePresetId | null) => void;
  onRename: (id: string, name: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const listId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const skipRenameBlur = useRef(false);
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState({ left: 0, top: 0, width: 0 });
  const [rowMenu, setRowMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const current = scenes.find((scene) => scene.id === activeId) ?? scenes[0];
  const renaming = Boolean(renameId);

  useEffect(() => {
    if (!open) {
      setRenameId(null);
      return;
    }
    if (triggerRef.current) setMenu(placeMenu(triggerRef.current, scenes.length));
    function onPointer(event: PointerEvent) {
      if (renaming) return;
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (triggerRef.current?.contains(target) || listRef.current?.contains(target)) return;
      setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (renaming) return;
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, scenes.length, renaming]);

  useEffect(() => {
    if (!renameId) return;
    const input = renameInputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, [renameId]);

  function beginRename(id: string) {
    const scene = scenes.find((item) => item.id === id);
    if (!scene || locked) return;
    skipRenameBlur.current = false;
    setOpen(true);
    setRenameId(id);
    setRenameDraft(scene.name);
  }

  function cancelRename() {
    skipRenameBlur.current = true;
    setRenameId(null);
    setRenameDraft("");
  }

  function commitRename() {
    if (skipRenameBlur.current) {
      skipRenameBlur.current = false;
      return;
    }
    if (!renameId) return;
    const next = renameDraft.trim();
    if (!next) {
      cancelRename();
      return;
    }
    onRename(renameId, next);
    skipRenameBlur.current = true;
    setRenameId(null);
    setRenameDraft("");
  }

  return (
    <div className="studio-scene-picker">
      <button
        ref={triggerRef}
        type="button"
        className={`studio-combo${open ? " is-open" : ""}`}
        disabled={locked}
        aria-label="Current scene"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => {
          if (!locked) setOpen((next) => !next);
        }}
      >
        <span className="studio-combo-copy">
          <span className="studio-combo-title">{current?.name ?? "Scene"}</span>
          <span className="studio-combo-meta">{scenes.length} saved</span>
        </span>
        <IconChevron size={16} className="studio-combo-chevron" />
      </button>
      <button
        type="button"
        className="studio-icon-btn studio-plus"
        title="New scene"
        disabled={locked}
        onClick={() => setCreateOpen(true)}
      >
        <IconPlus size={16} />
      </button>
      {open
        ? createPortal(
            <div
              ref={listRef}
              id={listId}
              className="studio-combo-menu studio-scene-menu"
              role="listbox"
              style={{ left: menu.left, top: menu.top, width: menu.width }}
            >
              {scenes.map((scene) => {
                const selected = scene.id === activeId;
                const editing = renameId === scene.id;
                return (
                  <div
                    key={scene.id}
                    className={`studio-scene-option${selected ? " is-selected" : ""}${editing ? " is-renaming" : ""}`}
                  >
                    {editing ? (
                      <div className="studio-scene-option-main is-editing">
                        <span className="studio-combo-copy">
                          <input
                            ref={renameInputRef}
                            type="text"
                            className="studio-scene-rename"
                            value={renameDraft}
                            maxLength={64}
                            aria-label="Scene name"
                            disabled={locked}
                            onChange={(event) => setRenameDraft(event.target.value)}
                            onClick={(event) => event.stopPropagation()}
                            onPointerDown={(event) => event.stopPropagation()}
                            onKeyDown={(event) => {
                              event.stopPropagation();
                              if (event.key === "Enter") {
                                event.preventDefault();
                                commitRename();
                              }
                              if (event.key === "Escape") {
                                event.preventDefault();
                                cancelRename();
                              }
                            }}
                            onBlur={() => commitRename()}
                          />
                          <span className="studio-combo-meta">
                            {scene.sources.filter(
                              (source) =>
                                source.type !== "microphone" &&
                                source.type !== "gameAudio" &&
                                source.type !== "desktopAudio",
                            ).length}{" "}
                            visual
                          </span>
                        </span>
                        {selected ? <IconCheck size={16} className="studio-combo-check" /> : null}
                      </div>
                    ) : (
                      <button
                        type="button"
                        role="option"
                        aria-selected={selected}
                        className="studio-scene-option-main"
                        onClick={() => {
                          onSelect(scene.id);
                          setOpen(false);
                        }}
                      >
                        <span className="studio-combo-copy">
                          <span className="studio-combo-title">{scene.name}</span>
                          <span className="studio-combo-meta">
                            {scene.sources.filter(
                              (source) =>
                                source.type !== "microphone" &&
                                source.type !== "gameAudio" &&
                                source.type !== "desktopAudio",
                            ).length}{" "}
                            visual
                          </span>
                        </span>
                        {selected ? <IconCheck size={16} className="studio-combo-check" /> : null}
                      </button>
                    )}
                    <button
                      type="button"
                      className="studio-icon-btn"
                      title="Scene actions"
                      disabled={locked || editing}
                      onClick={(event) => {
                        event.stopPropagation();
                        const rect = event.currentTarget.getBoundingClientRect();
                        setRowMenu({ id: scene.id, x: rect.right, y: rect.bottom + 4 });
                      }}
                    >
                      <IconMore size={15} />
                    </button>
                  </div>
                );
              })}
            </div>,
            document.body,
          )
        : null}
      {rowMenu ? (
        <ContextMenu
          x={rowMenu.x}
          y={rowMenu.y}
          onClose={() => setRowMenu(null)}
          items={[
            {
              label: "Rename",
              onClick: () => beginRename(rowMenu.id),
            },
            { label: "Duplicate", onClick: () => onDuplicate(rowMenu.id) },
            {
              label: "Delete",
              danger: true,
              disabled: scenes.length <= 1,
              onClick: () => {
                if (window.confirm("Delete this scene? This cannot be undone.")) onDelete(rowMenu.id);
              },
            },
          ]}
        />
      ) : null}
      {createOpen ? (
        <SceneNameDialog
          title="New scene"
          initialName={nextSceneName({ version: 2, activeId, scenes })}
          templates
          locked={locked}
          onClose={() => setCreateOpen(false)}
          onSave={(name, template) => {
            onCreate(name, template);
            setCreateOpen(false);
            setOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}

function SceneNameDialog({
  title,
  initialName,
  templates = false,
  locked,
  onClose,
  onSave,
}: {
  title: string;
  initialName: string;
  templates?: boolean;
  locked: boolean;
  onClose: () => void;
  onSave: (name: string, template: ScenePresetId | null) => void;
}) {
  const [name, setName] = useState(initialName);
  const [template, setTemplate] = useState<ScenePresetId | "">("");
  return (
    <div className="studio-modal-backdrop" onClick={onClose} role="presentation">
      <div className="studio-modal" role="dialog" aria-label={title} onClick={(event) => event.stopPropagation()}>
        <div className="studio-block-head">
          <h2>{title}</h2>
          <button type="button" className="studio-icon-btn" onClick={onClose}>
            Close
          </button>
        </div>
        <label className="studio-field">
          <span>Name</span>
          <input
            type="text"
            value={name}
            maxLength={64}
            autoFocus
            disabled={locked}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") onSave(name, template || null);
            }}
          />
        </label>
        {templates ? (
          <label className="studio-field">
            <span>Start from</span>
            <select value={template} disabled={locked} onChange={(event) => setTemplate(event.target.value as ScenePresetId | "")}>
              {TEMPLATES.map((item) => (
                <option key={item.id || "blank"} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <div className="studio-dialog-actions">
          <button type="button" className="studio-tool" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="studio-tool is-on"
            disabled={locked || !name.trim()}
            onClick={() => onSave(name, template || null)}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

function placeMenu(trigger: HTMLElement, count: number) {
  const rect = trigger.getBoundingClientRect();
  const height = Math.min(320, count * 52 + 12);
  const spaceBelow = window.innerHeight - rect.bottom - 8;
  const openUp = spaceBelow < height && rect.top > spaceBelow;
  return {
    left: Math.max(8, rect.left),
    width: Math.max(rect.width, 240),
    top: openUp ? Math.max(8, rect.top - height - 4) : rect.bottom + 4,
  };
}
