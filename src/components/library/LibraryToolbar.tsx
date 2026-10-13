import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  IconCalendar,
  IconChevron,
  IconClock,
  IconGamesFilter,
  IconGrid,
  IconList,
  IconSearch,
} from "../icons";
import type { DateFilter, DurationFilter, LibraryLayout, LibrarySort } from "../../library/libraryBrowse";

export function LibraryToolbar({
  query,
  onQuery,
  games,
  gameId,
  onGame,
  date,
  onDate,
  duration,
  onDuration,
  showGame,
  showDuration,
  layout,
  onLayout,
  sort,
  onSort,
}: {
  query: string;
  onQuery: (value: string) => void;
  games: { id: string; name: string }[];
  gameId: string;
  onGame: (id: string) => void;
  date: DateFilter;
  onDate: (value: DateFilter) => void;
  duration: DurationFilter;
  onDuration: (value: DurationFilter) => void;
  showGame: boolean;
  showDuration: boolean;
  layout: LibraryLayout;
  onLayout: (value: LibraryLayout) => void;
  sort: LibrarySort;
  onSort: (value: LibrarySort) => void;
}) {
  const gameName = games.find((game) => game.id === gameId)?.name ?? "All Games";
  return (
    <div className="library-toolbar">
      <label className="find-search library-search">
        <IconSearch size={16} />
        <input
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          placeholder="Search clips, games, or moments..."
          aria-label="Search clips, games, or moments"
        />
      </label>
      {showGame ? (
        <FilterMenu
          label={gameName}
          icon={<IconGamesFilter size={16} />}
          value={gameId}
          options={[{ id: "all", label: "All Games" }, ...games.map((game) => ({ id: game.id, label: game.name }))]}
          onChange={onGame}
        />
      ) : null}
      <FilterMenu
        label={date === "any" ? "Date" : dateLabel(date)}
        icon={<IconCalendar size={16} />}
        value={date}
        options={[
          { id: "any", label: "Any date" },
          { id: "today", label: "Today" },
          { id: "week", label: "This week" },
          { id: "month", label: "This month" },
        ]}
        onChange={(value) => onDate(value as DateFilter)}
      />
      {showDuration ? (
        <FilterMenu
          label={duration === "any" ? "Duration" : durationLabel(duration)}
          icon={<IconClock size={16} />}
          value={duration}
          options={[
            { id: "any", label: "Any duration" },
            { id: "short", label: "Under 30s" },
            { id: "mid", label: "30s–2m" },
            { id: "long", label: "Over 2m" },
          ]}
          onChange={(value) => onDuration(value as DurationFilter)}
        />
      ) : null}
      <div className="library-view-toggle" role="group" aria-label="Layout">
        <button type="button" className={layout === "grid" ? "active" : ""} aria-pressed={layout === "grid"} title="Grid" onClick={() => onLayout("grid")}>
          <IconGrid size={16} />
        </button>
        <button type="button" className={layout === "list" ? "active" : ""} aria-pressed={layout === "list"} title="List" onClick={() => onLayout("list")}>
          <IconList size={16} />
        </button>
      </div>
      <FilterMenu
        label={sort === "newest" ? "Newest" : "Oldest"}
        icon={<IconClock size={16} />}
        value={sort}
        options={[
          { id: "newest", label: "Newest" },
          { id: "oldest", label: "Oldest" },
        ]}
        onChange={(value) => onSort(value as LibrarySort)}
      />
    </div>
  );
}

function dateLabel(value: DateFilter) {
  if (value === "today") return "Today";
  if (value === "week") return "This week";
  if (value === "month") return "This month";
  return "Date";
}

function durationLabel(value: DurationFilter) {
  if (value === "short") return "Under 30s";
  if (value === "mid") return "30s–2m";
  if (value === "long") return "Over 2m";
  return "Duration";
}

function FilterMenu({
  label,
  icon,
  value,
  options,
  onChange,
}: {
  label: string;
  icon: ReactNode;
  value: string;
  options: { id: string; label: string }[];
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function onPointer(event: MouseEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    window.addEventListener("mousedown", onPointer);
    return () => window.removeEventListener("mousedown", onPointer);
  }, [open]);
  return (
    <div className={`library-filter ${open ? "open" : ""}`} ref={root}>
      <button type="button" className="library-chip" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
        {icon}
        <span>{label}</span>
        <IconChevron size={12} />
      </button>
      {open ? (
        <div className="library-filter-menu" role="listbox">
          {options.map((option) => (
            <button
              key={option.id}
              type="button"
              role="option"
              aria-selected={option.id === value}
              className={option.id === value ? "active" : ""}
              onClick={() => {
                onChange(option.id);
                setOpen(false);
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
