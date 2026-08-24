import { useEffect, useId, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { SocialAvatar } from "./SocialAvatar";
import { personName, searchUsers, type Relationship, type SocialUser } from "../lib/api.friends";
import { useAuth } from "../lib/auth";

type SearchHit = SocialUser & { relationship: Relationship };

export function HeaderSearch() {
  const { session } = useAuth();
  const token = session?.access_token;
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchHit[]>([]);
  const [error, setError] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  useEffect(() => {
    if (!open || !token) return;
    const needle = query.trim();
    if (needle.length < 2) {
      setResults([]);
      return;
    }
    const handle = window.setTimeout(() => {
      void searchUsers(token, needle)
        .then(setResults)
        .catch((caught) => setError(caught instanceof Error ? caught.message : "Could not search people."));
    }, 280);
    return () => window.clearTimeout(handle);
  }, [open, query, token]);

  function toggle() {
    if (!token) {
      navigate("/signin");
      return;
    }
    setOpen((value) => !value);
    setError(null);
  }

  return (
    <div className="header-popover-wrap" ref={wrapRef}>
      <button
        className="header-icon-btn"
        type="button"
        aria-label="Search people"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={toggle}
      >
        <SearchIcon />
      </button>
      {open ? (
        <div className="header-popover header-search-popover" id={menuId} role="dialog" aria-label="Search people">
          <form className="games-search" role="search" onSubmit={(event) => event.preventDefault()}>
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search a username"
              aria-label="Search a username"
              autoComplete="off"
            />
          </form>
          {error ? <p className="error">{error}</p> : null}
          {query.trim().length < 2 ? (
            <p className="muted">Type at least two characters to find someone.</p>
          ) : results.length === 0 ? (
            <p className="muted">No accounts match that username.</p>
          ) : (
            <ul className="header-popover-list">
              {results.map((user) => (
                <li key={user.id}>
                  <Link
                    className="header-popover-main"
                    to={user.username ? `/u/${user.username}` : "/friends"}
                    onClick={() => setOpen(false)}
                  >
                    <SocialAvatar name={personName(user)} avatarUrl={user.avatarUrl} size={36} />
                    <span>
                      <strong>{personName(user)}</strong>
                      <span className="muted">{user.username ? `@${user.username}` : "No username"}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

function SearchIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <circle cx="11" cy="11" r="6" />
      <path d="m20 20-4.2-4.2" />
    </svg>
  );
}
