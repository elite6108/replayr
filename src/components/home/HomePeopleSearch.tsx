import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { searchUsers } from "../../services/api.friends";
import type { Relationship, SocialUser } from "../../services/social-types";
import { useAuthStore } from "../../stores/authStore";
import { SocialAvatar } from "../common/SocialAvatar";
import { IconSearch } from "../icons";

type SearchHit = SocialUser & { relationship: Relationship };

export function HomePeopleSearch() {
  const token = useAuthStore((state) => state.session?.access_token);
  const navigate = useNavigate();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    const needle = query.replace(/^@/, "").trim();
    if (needle.length < 2) {
      setHits([]);
      return;
    }
    const handle = window.setTimeout(() => {
      void searchUsers(token, needle)
        .then((users) => {
          setHits(users);
          setOpen(true);
          setError(null);
        })
        .catch((caught) => setError(caught instanceof Error ? caught.message : "Could not search accounts."));
    }, 280);
    return () => window.clearTimeout(handle);
  }, [query, token]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  return (
    <div className="home-search" ref={wrapRef}>
      <form className="find-search" onSubmit={(event) => event.preventDefault()} role="search">
        <IconSearch size={16} />
        <input
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          placeholder="Search people"
          aria-label="Search people"
        />
      </form>
      {open && (query.trim().length >= 2 || error) ? (
        <div className="home-search-results">
          {error ? <p className="error-text">{error}</p> : null}
          {hits.length === 0 && !error ? <p className="muted">No accounts match that username.</p> : null}
          {hits.map((hit) => (
            <button
              key={hit.id}
              className="home-search-hit"
              type="button"
              onClick={() => {
                if (hit.username) navigate(`/u/${hit.username}`);
                setOpen(false);
                setQuery("");
              }}
            >
              <SocialAvatar person={hit} size="sm" />
              <span>
                <strong>{hit.displayName || hit.username || "Player"}</strong>
                <span className="muted">{hit.username ? `@${hit.username}` : "No username"}</span>
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
