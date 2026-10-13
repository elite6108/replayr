import { useEffect, useState } from "react";
import { ContextMenu } from "../common/ContextMenu";
import {
  IconCalendar,
  IconCaretLeft,
  IconCaretRight,
  IconClock,
  IconDrive,
  IconFit,
  IconMonitor,
  IconMore,
  IconPencil,
  IconPlay,
  IconPlus,
  IconShare,
} from "../icons";

export type LibraryRelatedClip = {
  id: string;
  title: string;
  thumbUrl: string | null;
  gameName: string | null;
  whenLabel: string;
  durationLabel: string;
};

export type LibraryInfoModel = {
  key: string;
  title: string;
  thumbUrl: string | null;
  gameName: string | null;
  gameArt: string | null;
  whenLabel: string;
  clockLabel: string;
  durationLabel: string;
  resolutionLabel: string;
  sizeLabel: string;
  description: string;
  tags: string[];
  canEditMeta: boolean;
  canEdit: boolean;
  canShare: boolean;
  related: LibraryRelatedClip[];
};

export function LibraryInfoPane({
  model,
  hasPrev,
  hasNext,
  onPrev,
  onNext,
  onPlay,
  onEdit,
  onShare,
  onRename,
  onDescription,
  onTags,
  onRelated,
  onSeeAll,
  moreItems,
}: {
  model: LibraryInfoModel;
  hasPrev: boolean;
  hasNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  onPlay: () => void;
  onEdit: () => void;
  onShare: () => void;
  onRename: (title: string) => void;
  onDescription: (description: string) => void;
  onTags: (tags: string[]) => void;
  onRelated: (id: string) => void;
  onSeeAll: () => void;
  moreItems: { label: string; danger?: boolean; disabled?: boolean; onClick: () => void }[];
}) {
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(model.title);
  const [description, setDescription] = useState(model.description);
  const [addingTag, setAddingTag] = useState(false);
  const [tagDraft, setTagDraft] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    setRenaming(false);
    setTitle(model.title);
    setDescription(model.description);
    setAddingTag(false);
    setTagDraft("");
  }, [model.key, model.title, model.description]);

  function commitTitle() {
    const next = title.trim();
    setRenaming(false);
    if (next && next !== model.title) onRename(next);
    else setTitle(model.title);
  }

  function commitDescription() {
    if (description !== model.description) onDescription(description);
  }

  function addTag() {
    const next = tagDraft.trim().replace(/\s+/g, " ");
    setTagDraft("");
    setAddingTag(false);
    if (!next || model.tags.some((tag) => tag.toLowerCase() === next.toLowerCase())) return;
    onTags([...model.tags, next]);
  }

  return (
    <aside className="library-info" aria-label="Clip info">
      <div className="library-info-media">
        {model.thumbUrl ? <img src={model.thumbUrl} alt="" /> : <div className="library-info-empty" />}
        <button type="button" className="library-info-nav prev" disabled={!hasPrev} aria-label="Previous clip" onClick={onPrev}>
          <IconCaretLeft size={14} />
        </button>
        <button type="button" className="library-info-nav next" disabled={!hasNext} aria-label="Next clip" onClick={onNext}>
          <IconCaretRight size={14} />
        </button>
        <button type="button" className="library-info-expand" aria-label="Open clip" onClick={onPlay}>
          <IconFit size={14} />
        </button>
        <button type="button" className="library-info-play" aria-label="Play clip" onClick={onPlay}>
          <IconPlay size={18} />
        </button>
        {model.clockLabel ? <span className="clip-duration">{model.clockLabel}</span> : null}
      </div>
      <div className="library-info-body">
        <div className="library-info-title">
          {renaming ? (
            <input
              value={title}
              autoFocus
              aria-label="Clip name"
              onChange={(event) => setTitle(event.target.value)}
              onBlur={commitTitle}
              onKeyDown={(event) => {
                if (event.key === "Enter") commitTitle();
                if (event.key === "Escape") {
                  setTitle(model.title);
                  setRenaming(false);
                }
              }}
            />
          ) : (
            <h2>{model.title || "Untitled clip"}</h2>
          )}
          {model.canEditMeta && !renaming ? (
            <button type="button" aria-label="Rename clip" onClick={() => setRenaming(true)}>
              <IconPencil size={14} />
            </button>
          ) : null}
        </div>
        {model.gameName ? (
          <div className="clip-game-row">
            {model.gameArt ? <img src={model.gameArt} alt="" /> : <span className="clip-game-fallback" />}
            <span>{model.gameName}</span>
          </div>
        ) : null}
        <ul className="library-info-facts">
          <li>
            <IconCalendar size={15} />
            <span>{model.whenLabel}</span>
          </li>
          <li>
            <IconClock size={15} />
            <span>{model.durationLabel}</span>
          </li>
          <li>
            <IconMonitor size={15} />
            <span>{model.resolutionLabel}</span>
          </li>
          <li>
            <IconDrive size={15} />
            <span>{model.sizeLabel}</span>
          </li>
        </ul>
        <div className="library-info-actions">
          {model.canEdit ? (
            <button type="button" className="btn primary library-edit" onClick={onEdit}>
              <IconPencil size={14} />
              Edit Clip
            </button>
          ) : null}
          <button type="button" className="btn library-share" disabled={!model.canShare} onClick={onShare}>
            <IconShare size={14} />
            Share
          </button>
          <button
            type="button"
            className="btn library-more"
            aria-label="More clip actions"
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              setMenu({ x: rect.right, y: rect.bottom + 6 });
            }}
          >
            <IconMore size={16} />
          </button>
        </div>
        {model.canEditMeta ? (
          <label className="library-info-description">
            <textarea
              value={description}
              placeholder="Add a description..."
              rows={2}
              onChange={(event) => setDescription(event.target.value)}
              onBlur={commitDescription}
            />
          </label>
        ) : null}
        {model.canEditMeta ? (
          <section className="library-info-tags">
            <h3>Tags</h3>
            <div>
              {model.tags.map((tag) => (
                <span key={tag}>
                  {tag}
                  <button type="button" aria-label={`Remove ${tag}`} onClick={() => onTags(model.tags.filter((item) => item !== tag))}>
                    ×
                  </button>
                </span>
              ))}
              {addingTag ? (
                <input
                  value={tagDraft}
                  autoFocus
                  aria-label="New tag"
                  placeholder="Tag"
                  onChange={(event) => setTagDraft(event.target.value)}
                  onBlur={addTag}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      addTag();
                    }
                    if (event.key === "Escape") {
                      setTagDraft("");
                      setAddingTag(false);
                    }
                  }}
                />
              ) : (
                <button type="button" className="library-add-tag" onClick={() => setAddingTag(true)}>
                  <IconPlus size={12} />
                  Add tag
                </button>
              )}
            </div>
          </section>
        ) : null}
        {model.related.length > 0 ? (
          <section className="library-related">
            <div>
              <h3>Related Clips</h3>
              <button type="button" onClick={onSeeAll}>
                See all
              </button>
            </div>
            <ul>
              {model.related.map((clip) => (
                <li key={clip.id}>
                  <button type="button" onClick={() => onRelated(clip.id)}>
                    <span className="library-related-thumb">
                      {clip.thumbUrl ? <img src={clip.thumbUrl} alt="" /> : null}
                      <em>{clip.durationLabel}</em>
                    </span>
                    <span>
                      <strong>{clip.title}</strong>
                      {clip.gameName ? <small>{clip.gameName}</small> : null}
                      <small>{clip.whenLabel}</small>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
      {menu ? <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={moreItems} /> : null}
    </aside>
  );
}
