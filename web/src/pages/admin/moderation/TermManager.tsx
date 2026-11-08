import { FormEvent, useEffect, useState } from "react";
import {
  createModerationTerm,
  fetchModerationTerms,
  setModerationTermRetired,
  type ModerationTerm,
} from "../../../lib/admin";
import { useAuth } from "../../../lib/auth";
import { formatClipDate } from "../../../lib/format";

const CATEGORIES = ["profanity", "slur", "sexual", "threat", "other"] as const;

export function TermManager() {
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [state, setState] = useState<"active" | "retired" | "all">("active");
  const [page, setPage] = useState(1);
  const [terms, setTerms] = useState<ModerationTerm[]>([]);
  const [total, setTotal] = useState(0);
  const [limit, setLimit] = useState(50);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [draftCategory, setDraftCategory] = useState<(typeof CATEGORIES)[number]>("profanity");
  const [draftNote, setDraftNote] = useState("");

  async function load(nextPage = page) {
    if (!token) return;
    setError(null);
    try {
      const body = await fetchModerationTerms(token, {
        q: query.trim() || undefined,
        category: category || undefined,
        state,
        page: nextPage,
      });
      setTerms(body.terms);
      setTotal(body.total);
      setLimit(body.limit);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load terms.");
    }
  }

  useEffect(() => {
    void load(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, state, category]);

  async function add(event: FormEvent) {
    event.preventDefault();
    if (!token || !draft.trim()) return;
    setBusyId("new");
    setError(null);
    try {
      await createModerationTerm(token, {
        term: draft.trim(),
        category: draftCategory,
        note: draftNote.trim() || undefined,
      });
      setDraft("");
      setDraftNote("");
      setPage(1);
      await load(1);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not add that term.");
    } finally {
      setBusyId(null);
    }
  }

  async function toggle(term: ModerationTerm) {
    if (!token) return;
    const retiring = !term.retiredAt;
    if (retiring && !window.confirm(`Stop blocking “${term.term}”?`)) return;
    setBusyId(term.id);
    setError(null);
    try {
      await setModerationTermRetired(token, term.id, retiring);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update that term.");
    } finally {
      setBusyId(null);
    }
  }

  const pageCount = Math.max(1, Math.ceil(total / Math.max(1, limit)));

  return (
    <>
      <p className="muted">
        Matching uses the normalized key: letters only, after common number and symbol substitutions. Whole words and
        phrases match. Substrings do not, so a short term will not catch a longer word that contains it. Add the
        spellings you want caught. Terms that normalize to fewer than three letters are rejected.
      </p>
      <form className="admin-filters" onSubmit={(event) => void add(event)}>
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          maxLength={64}
          placeholder="Word or phrase"
          aria-label="Term"
          required
        />
        <select
          value={draftCategory}
          aria-label="Category"
          onChange={(event) => setDraftCategory(event.target.value as (typeof CATEGORIES)[number])}
        >
          {CATEGORIES.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
        <input
          value={draftNote}
          onChange={(event) => setDraftNote(event.target.value)}
          maxLength={200}
          placeholder="Note for staff (optional)"
          aria-label="Note"
        />
        <button className="admin-btn primary" type="submit" disabled={busyId === "new" || !draft.trim()}>
          Add term
        </button>
      </form>
      <form
        className="admin-filters"
        onSubmit={(event) => {
          event.preventDefault();
          setPage(1);
          void load(1);
        }}
      >
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search terms"
          aria-label="Search terms"
        />
        <select
          value={category}
          aria-label="Filter category"
          onChange={(event) => {
            setCategory(event.target.value);
            setPage(1);
          }}
        >
          <option value="">All categories</option>
          {CATEGORIES.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
        <select
          value={state}
          aria-label="Term state"
          onChange={(event) => {
            setState(event.target.value as typeof state);
            setPage(1);
          }}
        >
          <option value="active">Active</option>
          <option value="retired">Retired</option>
          <option value="all">All</option>
        </select>
        <button className="admin-btn" type="submit">
          Search
        </button>
      </form>
      {error ? <p className="error">{error}</p> : null}
      <div className="admin-panel admin-table-card">
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Term</th>
                <th>Normalized</th>
                <th>Category</th>
                <th>Added</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {terms.map((term) => (
                <tr key={term.id}>
                  <td>
                    <strong>{term.term}</strong>
                    {term.note ? <span className="muted">{term.note}</span> : null}
                  </td>
                  <td>
                    <code>{term.normalized}</code>
                  </td>
                  <td>
                    <span className="admin-pill">{term.category}</span>
                  </td>
                  <td>
                    {formatClipDate(term.createdAt)}
                    {term.retiredAt ? <span className="muted">Retired {formatClipDate(term.retiredAt)}</span> : null}
                  </td>
                  <td className="admin-actions">
                    <button className="admin-btn" type="button" disabled={busyId === term.id} onClick={() => void toggle(term)}>
                      {term.retiredAt ? "Restore" : "Retire"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {terms.length === 0 ? <p className="muted admin-empty">No terms match.</p> : null}
        </div>
      </div>
      {pageCount > 1 ? (
        <div className="row">
          <button
            className="admin-btn"
            type="button"
            disabled={page <= 1}
            onClick={() => {
              const next = page - 1;
              setPage(next);
              void load(next);
            }}
          >
            Previous
          </button>
          <span className="muted">
            Page {page} of {pageCount}
          </span>
          <button
            className="admin-btn"
            type="button"
            disabled={page >= pageCount}
            onClick={() => {
              const next = page + 1;
              setPage(next);
              void load(next);
            }}
          >
            Next
          </button>
        </div>
      ) : null}
    </>
  );
}
