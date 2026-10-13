import { FormEvent, useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "../../lib/auth";
import {
  blockLearnedProcess,
  draftCatalogGame,
  fetchCatalogGames,
  fetchLearnedProcesses,
  promoteLearnedProcess,
  saveCatalogGame,
  searchSteamGames,
  unblockLearnedProcess,
  type CatalogGame,
  type LearnedProcess,
  type SteamHit,
} from "../../lib/gameCatalog";
import { useStaffPermissions } from "../../lib/staff";
import { AdminPageHeader } from "./components/AdminPageHeader";

type GameForm = {
  slug: string;
  name: string;
  publisher: string;
  coverUrl: string;
  processNames: string;
  steamAppId?: number;
};

const emptyForm: GameForm = { slug: "", name: "", publisher: "", coverUrl: "", processNames: "" };

export function AdminGamesPage() {
  const { can, loading } = useStaffPermissions();
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const [query, setQuery] = useState("");
  const [games, setGames] = useState<CatalogGame[]>([]);
  const [steamQuery, setSteamQuery] = useState("");
  const [steamHits, setSteamHits] = useState<SteamHit[]>([]);
  const [learned, setLearned] = useState<LearnedProcess[]>([]);
  const [form, setForm] = useState<GameForm>(emptyForm);
  const [editingSlug, setEditingSlug] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function loadGames(nextQuery = query) {
    const rows = await fetchCatalogGames(token, nextQuery);
    setGames(rows);
  }

  async function loadLearned() {
    setLearned(await fetchLearnedProcesses(token));
  }

  useEffect(() => {
    if (!token || loading || !can("games.manage")) return;
    void loadGames("").catch((caught) => setError(messageOf(caught)));
    void loadLearned().catch((caught) => setError(messageOf(caught)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, loading]);

  if (!loading && !can("games.manage")) return <Navigate to="/admin" replace />;

  function useForm(next: GameForm, slug: string | null) {
    setForm(next);
    setEditingSlug(slug);
    setMessage(null);
    setError(null);
  }

  function editGame(game: CatalogGame) {
    useForm(
      {
        slug: game.slug,
        name: game.name,
        publisher: game.publisher ?? "",
        coverUrl: game.coverUrl ?? "",
        processNames: game.processNames.join(", "),
      },
      game.slug,
    );
  }

  async function onSave(event: FormEvent) {
    event.preventDefault();
    if (!token) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const saved = await saveCatalogGame(
        token,
        {
          slug: form.slug || undefined,
          name: form.name,
          publisher: form.publisher,
          coverUrl: form.coverUrl,
          processNames: form.processNames,
        },
        editingSlug ?? undefined,
      );
      setMessage(editingSlug ? `Updated ${saved.name}.` : `Added ${saved.name}.`);
      setEditingSlug(saved.slug);
      setForm((current) => ({ ...current, slug: saved.slug, processNames: saved.processNames.join(", ") }));
      await loadGames();
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  async function onDraft() {
    if (!token || !form.name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const draft = await draftCatalogGame(token, form.name, form.steamAppId);
      setForm((current) => ({
        ...current,
        name: draft.name || current.name,
        publisher: draft.publisher ?? current.publisher,
        coverUrl: draft.coverUrl ?? current.coverUrl,
        processNames: draft.processNames.length ? draft.processNames.join(", ") : current.processNames,
      }));
      setMessage(draft.processNames.length ? "Draft ready. Review the .exe, then save." : "Draft ready, but the executable still needs to be entered.");
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  async function onSteamSearch(event: FormEvent) {
    event.preventDefault();
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      setSteamHits(await searchSteamGames(token, steamQuery));
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  async function onPromote(row: LearnedProcess) {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await promoteLearnedProcess(token, row.processName, row.windowTitle);
      setMessage(`Added ${saved.name} from play.`);
      await Promise.all([loadGames(), loadLearned()]);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  async function onBlock(row: LearnedProcess) {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      if (row.blocked) await unblockLearnedProcess(token, row.processName);
      else await blockLearnedProcess(token, row.processName);
      await loadLearned();
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="admin-dash">
      <AdminPageHeader
        eyebrow="Catalog"
        title="Games"
        description="Detection uses the executable name. Steam search only supplies the title and cover. A draft is not saved until you confirm it."
      />
      {error ? <p className="error">{error}</p> : null}
      {message ? <p className="admin-dash-caption">{message}</p> : null}

      <form className="admin-panel admin-game-form" onSubmit={onSave}>
        <div className="admin-panel-head">
          <h3>{editingSlug ? "Edit game" : "Add game"}</h3>
          {editingSlug ? (
            <button className="admin-btn ghost" type="button" onClick={() => useForm(emptyForm, null)}>
              New game
            </button>
          ) : null}
        </div>
        <label>
          Name
          <input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required />
        </label>
        <label>
          Publisher
          <input value={form.publisher} onChange={(event) => setForm({ ...form, publisher: event.target.value })} />
        </label>
        <label>
          Process names
          <input
            value={form.processNames}
            onChange={(event) => setForm({ ...form, processNames: event.target.value })}
            placeholder="HoodWarfare.exe"
            required
          />
        </label>
        <label>
          Cover URL
          <input value={form.coverUrl} onChange={(event) => setForm({ ...form, coverUrl: event.target.value })} placeholder="https://" />
        </label>
        <div className="admin-game-actions">
          <button className="admin-btn" type="button" disabled={busy || !form.name.trim()} onClick={() => void onDraft()}>
            Draft with AI
          </button>
          <button className="admin-btn primary" type="submit" disabled={busy}>
            {editingSlug ? "Save changes" : "Save game"}
          </button>
        </div>
      </form>

      <section className="admin-panel">
        <div className="admin-panel-head">
          <h3>Detection catalog</h3>
          <form
            className="admin-filters"
            onSubmit={(event) => {
              event.preventDefault();
              void loadGames().catch((caught) => setError(messageOf(caught)));
            }}
          >
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search games" aria-label="Search games" />
            <button className="admin-btn" type="submit">
              Search
            </button>
          </form>
        </div>
        <GameTable games={games} onEdit={editGame} />
      </section>

      <section className="admin-panel">
        <div className="admin-panel-head">
          <h3>Steam</h3>
          <form className="admin-filters" onSubmit={onSteamSearch}>
            <input value={steamQuery} onChange={(event) => setSteamQuery(event.target.value)} placeholder="Search Steam" aria-label="Search Steam" />
            <button className="admin-btn" type="submit" disabled={busy}>
              Search
            </button>
          </form>
        </div>
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Title</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {steamHits.map((hit) => (
                <tr key={hit.appId}>
                  <td>
                    <strong>{hit.name}</strong>
                    <span className="muted">App {hit.appId}</span>
                  </td>
                  <td>
                    <button
                      className="admin-btn"
                      type="button"
                      onClick={() =>
                        useForm(
                          { ...emptyForm, name: hit.name, coverUrl: hit.coverUrl ?? "", steamAppId: hit.appId },
                          null,
                        )
                      }
                    >
                      Use in form
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="admin-panel">
        <div className="admin-panel-head">
          <h3>Learned from play</h3>
        </div>
        <p className="admin-dash-caption">Replayr adds a game on its own after three installs on different networks agree on the title. You can add or block one sooner.</p>
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Game</th>
                <th>Installs</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {learned.map((row) => (
                <tr key={row.processName}>
                  <td>
                    <strong>{row.windowTitle}</strong>
                    <span className="muted">
                      {row.processName}
                      {row.promotedSlug ? ` · ${row.promotedSlug}` : ""}
                      {row.blocked ? " · blocked" : ""}
                    </span>
                  </td>
                  <td>
                    {row.distinctInstalls}
                    <span className="muted">{row.titleVotes} agree</span>
                  </td>
                  <td className="admin-row-actions">
                    <button className="admin-btn" type="button" disabled={busy || row.blocked || row.distinctInstalls === 0} onClick={() => void onPromote(row)}>
                      Add
                    </button>
                    <button
                      className="admin-btn"
                      type="button"
                      disabled={row.distinctInstalls === 0}
                      onClick={() => {
                        const existing = games.find((game) => game.slug === row.promotedSlug);
                        if (existing) editGame(existing);
                        else useForm({ ...emptyForm, name: row.windowTitle, processNames: row.processName }, null);
                      }}
                    >
                      Correct
                    </button>
                    <button className="admin-btn danger" type="button" disabled={busy} onClick={() => void onBlock(row)}>
                      {row.blocked ? "Unblock" : "Block"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </section>
  );
}

function GameTable({ games, onEdit }: { games: CatalogGame[]; onEdit: (game: CatalogGame) => void }) {
  return (
    <div className="admin-table-wrap">
      <table className="admin-table">
        <thead>
          <tr>
            <th>Game</th>
            <th>Executable</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {games.map((game) => (
            <tr key={game.slug}>
              <td>
                <strong>{game.name}</strong>
                <span className="muted">{game.publisher || game.slug}</span>
              </td>
              <td>{game.processNames.join(", ") || "None"}</td>
              <td>
                <button className="admin-btn" type="button" onClick={() => onEdit(game)}>
                  Edit
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function messageOf(caught: unknown): string {
  return caught instanceof Error ? caught.message : "Something went wrong.";
}
