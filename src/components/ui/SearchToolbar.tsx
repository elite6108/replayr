import type { ReactNode } from "react";
import { IconSearch } from "../icons";

export function SearchToolbar({
  value,
  onChange,
  placeholder,
  children,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  children?: ReactNode;
}) {
  return (
    <div className="search-toolbar">
      {children}
      <label className="find-search">
        <IconSearch size={16} />
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder ?? "Search"}
          aria-label={placeholder ?? "Search"}
        />
      </label>
    </div>
  );
}
