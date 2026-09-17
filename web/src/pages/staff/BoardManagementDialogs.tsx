import { useCallback, useEffect, useMemo, useState } from "react";
import {
  deleteStaffBoard,
  fetchStaffBoardMembers,
  removeStaffBoardMember,
  setStaffBoardEmailNotifications,
  setStaffBoardMemberRole,
  type StaffBoardDetail,
  type StaffBoardMembers,
  type StaffBoardRole,
} from "../../lib/staff";
import { initials } from "./boardUi";

const BOARD_ROLES: StaffBoardRole[] = ["admin", "editor", "viewer"];

function messageFrom(caught: unknown, fallback: string) {
  return caught instanceof Error ? caught.message : fallback;
}

export function BoardMembersDialog({
  token,
  board,
  onClose,
  onChanged,
}: {
  token: string;
  board: StaffBoardDetail;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [data, setData] = useState<StaffBoardMembers | null>(null);
  const [query, setQuery] = useState("");
  const [candidateRoles, setCandidateRoles] = useState<Record<string, StaffBoardRole>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [emailEnabled, setEmailEnabled] = useState(board.emailEnabled !== false);
  const [emailBusy, setEmailBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    const next = await fetchStaffBoardMembers(token, board.id);
    setData(next);
  }, [token, board.id]);

  useEffect(() => {
    void load().catch((caught: unknown) => setError(messageFrom(caught, "Could not load board members.")));
  }, [load]);

  useEffect(() => {
    setEmailEnabled(board.emailEnabled !== false);
  }, [board.emailEnabled]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape" && !busyId) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busyId, onClose]);

  const candidates = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return data?.candidates ?? [];
    return (data?.candidates ?? []).filter((candidate) => candidate.displayName.toLocaleLowerCase().includes(needle));
  }, [data?.candidates, query]);

  async function mutate(staffId: string, action: () => Promise<unknown>, fallback: string) {
    setBusyId(staffId);
    setError(null);
    try {
      await action();
      await Promise.all([load(), onChanged()]);
      setConfirmRemoveId(null);
    } catch (caught) {
      setError(messageFrom(caught, fallback));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="ops-modal" role="dialog" aria-modal="true" aria-labelledby="board-members-title">
      <button className="ops-modal-backdrop" type="button" onClick={busyId ? undefined : onClose} aria-label="Close member management" />
      <section className="ops-modal-sheet ops-members-dialog">
        <header className="ops-modal-header">
          <div>
            <p className="ops-eyebrow">Board access</p>
            <h2 id="board-members-title">Members of {board.name}</h2>
          </div>
          <button className="ops-ghost" type="button" onClick={onClose} disabled={Boolean(busyId)} aria-label="Close">
            Close
          </button>
        </header>

        {error ? <p className="ops-error" role="alert">{error}</p> : null}
        <label className="ops-email-pref ops-email-pref-inline">
          <input
            type="checkbox"
            checked={emailEnabled}
            disabled={emailBusy}
            onChange={() => {
              const next = !emailEnabled;
              setEmailBusy(true);
              setError(null);
              void setStaffBoardEmailNotifications(token, board.id, next)
                .then((body) => {
                  setEmailEnabled(body.emailEnabled);
                  return onChanged();
                })
                .catch((caught: unknown) => setError(messageFrom(caught, "Could not update board emails.")))
                .finally(() => setEmailBusy(false));
            }}
          />
          <span>
            <strong>Email me when this board changes</strong>
            <small>Mute this board even if all-boards email is on. You still will not get mail for your own edits.</small>
          </span>
        </label>
        {!data && !error ? <p className="ops-modal-status">Loading members…</p> : null}
        {!data && error ? (
          <button className="ops-ghost" type="button" onClick={() => void load().catch((caught: unknown) => setError(messageFrom(caught, "Could not load board members.")))}>
            Try again
          </button>
        ) : null}

        {data ? (
          <>
            <div className="ops-member-list" aria-label="Current board members">
              {data.members.map((member) => {
                const busy = busyId === member.staffId;
                return (
                  <div className="ops-member-row" key={member.staffId}>
                    <span className="ops-avatar">{initials(member.displayName)}</span>
                    <span className="ops-member-name">
                      <strong>{member.displayName}</strong>
                      {member.isOwner ? <small>Board owner</small> : null}
                    </span>
                    <select
                      className="ops-select"
                      value={member.boardRole}
                      aria-label={`Role for ${member.displayName}`}
                      disabled={member.isOwner || busy}
                      onChange={(event) => {
                        const boardRole = event.target.value as StaffBoardRole;
                        void mutate(
                          member.staffId,
                          () => setStaffBoardMemberRole(token, board.id, member.staffId, boardRole),
                          "Could not change member role.",
                        );
                      }}
                    >
                      {BOARD_ROLES.map((role) => <option key={role} value={role}>{role}</option>)}
                    </select>
                    {member.isOwner ? (
                      <span className="ops-member-lock" title="The board owner cannot be changed or removed">Locked</span>
                    ) : confirmRemoveId === member.staffId ? (
                      <span className="ops-member-confirm">
                        <button
                          className="ops-danger compact"
                          type="button"
                          disabled={busy}
                          onClick={() => void mutate(
                            member.staffId,
                            () => removeStaffBoardMember(token, board.id, member.staffId),
                            "Could not remove member.",
                          )}
                        >
                          {busy ? "Removing…" : "Confirm"}
                        </button>
                        <button className="ops-ghost" type="button" onClick={() => setConfirmRemoveId(null)}>Cancel</button>
                      </span>
                    ) : (
                      <button className="ops-ghost" type="button" disabled={Boolean(busyId)} onClick={() => setConfirmRemoveId(member.staffId)}>
                        Remove
                      </button>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="ops-member-add">
              <div>
                <h3>Add a member</h3>
                <p>Only staff without access to this board are shown.</p>
              </div>
              <label className="ops-search">
                <span aria-hidden="true">⌕</span>
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search staff"
                  aria-label="Search staff candidates"
                />
              </label>
              <div className="ops-candidate-list">
                {candidates.map((candidate) => {
                  const role = candidateRoles[candidate.id] ?? "viewer";
                  const busy = busyId === candidate.id;
                  return (
                    <div className="ops-member-row" key={candidate.id}>
                      <span className="ops-avatar">{initials(candidate.displayName)}</span>
                      <strong className="ops-member-name">{candidate.displayName}</strong>
                      <select
                        className="ops-select"
                        value={role}
                        disabled={busy}
                        aria-label={`Role for ${candidate.displayName}`}
                        onChange={(event) => setCandidateRoles((current) => ({
                          ...current,
                          [candidate.id]: event.target.value as StaffBoardRole,
                        }))}
                      >
                        {BOARD_ROLES.map((value) => <option key={value} value={value}>{value}</option>)}
                      </select>
                      <button
                        className="ops-create sm"
                        type="button"
                        disabled={Boolean(busyId)}
                        onClick={() => void mutate(
                          candidate.id,
                          () => setStaffBoardMemberRole(token, board.id, candidate.id, role),
                          "Could not add member.",
                        )}
                      >
                        {busy ? "Adding…" : "Add"}
                      </button>
                    </div>
                  );
                })}
                {!candidates.length ? <p className="ops-modal-status">{query ? "No matching staff." : "Everyone eligible already has access."}</p> : null}
              </div>
            </div>
          </>
        ) : null}
      </section>
    </div>
  );
}

export function DeleteBoardDialog({
  token,
  board,
  onClose,
  onDeleted,
}: {
  token: string;
  board: StaffBoardDetail;
  onClose: () => void;
  onDeleted: () => Promise<void>;
}) {
  const [confirmName, setConfirmName] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const matches = confirmName === board.name;

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape" && !deleting) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [deleting, onClose]);

  async function submit() {
    if (!matches || deleting) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteStaffBoard(token, board.id, confirmName);
      await onDeleted();
    } catch (caught) {
      setError(messageFrom(caught, "Could not delete board."));
      setDeleting(false);
    }
  }

  return (
    <div className="ops-modal" role="dialog" aria-modal="true" aria-labelledby="delete-board-title">
      <button className="ops-modal-backdrop" type="button" onClick={deleting ? undefined : onClose} aria-label="Cancel board deletion" />
      <form
        className="ops-modal-sheet ops-delete-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <p className="ops-eyebrow danger">Permanent action</p>
        <h2 id="delete-board-title">Delete {board.name}?</h2>
        <p>This permanently deletes the board and its contents. This cannot be undone.</p>
        <label>
          Type <strong>{board.name}</strong> to confirm
          <input
            autoFocus
            value={confirmName}
            onChange={(event) => setConfirmName(event.target.value)}
            disabled={deleting}
            autoComplete="off"
          />
        </label>
        {error ? <p className="ops-error" role="alert">{error}</p> : null}
        <div className="ops-modal-actions">
          <button className="ops-ghost" type="button" onClick={onClose} disabled={deleting}>Cancel</button>
          <button className="ops-danger" type="submit" disabled={!matches || deleting}>
            {deleting ? "Deleting…" : "Delete board permanently"}
          </button>
        </div>
      </form>
    </div>
  );
}
