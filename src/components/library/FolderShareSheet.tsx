import { useEffect, useMemo, useState } from "react";
import { searchUsers } from "../../services/api.friends";
import { folderRoleLabel } from "../../services/api.folders";
import type { FolderMember, FolderMemberRole, SocialUser } from "../../services/social-types";
import { useAuthStore } from "../../stores/authStore";
import { useFolderStore } from "../../stores/folderStore";
import { SocialAvatar } from "../common/SocialAvatar";

export function FolderShareSheet({ folderId, onClose }: { folderId: string; onClose: () => void }) {
  const token = useAuthStore((state) => state.session?.access_token);
  const share = useFolderStore((state) => state.share);
  const folder = useFolderStore((state) => state.activeFolder);
  const loading = useFolderStore((state) => state.shareLoading);
  const loadShare = useFolderStore((state) => state.loadShare);
  const invite = useFolderStore((state) => state.invite);
  const changeRole = useFolderStore((state) => state.changeRole);
  const removeMember = useFolderStore((state) => state.removeMember);
  const revokeInvite = useFolderStore((state) => state.revokeInvite);
  const enablePublicLink = useFolderStore((state) => state.enablePublicLink);
  const disablePublicLink = useFolderStore((state) => state.disablePublicLink);
  const regeneratePublicLink = useFolderStore((state) => state.regeneratePublicLink);
  const setPublicDownloads = useFolderStore((state) => state.setPublicDownloads);
  const transferOwnership = useFolderStore((state) => state.transferOwnership);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SocialUser[]>([]);
  const [picked, setPicked] = useState<SocialUser | null>(null);
  const [role, setRole] = useState<FolderMemberRole>("viewer");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void loadShare(folderId);
  }, [folderId, loadShare]);

  useEffect(() => {
    if (share.inviteRoles.length > 0 && !share.inviteRoles.includes(role)) {
      setRole(share.inviteRoles[0] ?? "viewer");
    }
  }, [role, share.inviteRoles]);

  useEffect(() => {
    if (!token || query.trim().length < 2) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void searchUsers(token, query).then((users) => {
        if (!cancelled) setResults(users);
      });
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, token]);

  const managers = useMemo(() => share.members.filter((item) => item.role === "manager"), [share.members]);
  const editors = useMemo(() => share.members.filter((item) => item.role === "editor"), [share.members]);
  const viewers = useMemo(() => share.members.filter((item) => item.role === "viewer"), [share.members]);
  const canInvite = Boolean(share.permissions?.manageMembers && share.inviteRoles.length > 0);

  async function sendInvite() {
    if (!picked || busy) return;
    setBusy(true);
    const sent = await invite(folderId, { userId: picked.id, role });
    setBusy(false);
    if (sent) {
      setPicked(null);
      setQuery("");
      setResults([]);
    }
  }

  return (
    <div className="send-overlay" role="dialog" aria-modal="true" aria-label="Share folder">
      <button type="button" className="player-backdrop" aria-label="Close" onClick={onClose} />
      <section className="send-sheet folder-share-sheet">
        <h2>Share</h2>
        <p className="muted">People with access stay separate from the public link.</p>
        {loading && !share.owner ? <p className="muted">Loading people…</p> : null}
        <PublicLinkSection
          folderId={folderId}
          canManage={Boolean(share.permissions?.managePublicShare)}
          publicShare={share.publicShare}
          visibility={folder?.visibility}
          onEnable={() => void enablePublicLink(folderId)}
          onDisable={() => void disablePublicLink(folderId)}
          onRegenerate={() => void regeneratePublicLink(folderId)}
          onDownloads={(value) => void setPublicDownloads(folderId, value)}
        />

        {share.owner ? (
          <div className="stack">
            <h3>Owner</h3>
            <PersonRow name={share.owner.displayName} user={share.owner} badge="Owner" />
            <MemberGroup title="Managers" members={managers} folderId={folderId} onChange={changeRole} onRemove={removeMember} />
            <MemberGroup title="Editors" members={editors} folderId={folderId} onChange={changeRole} onRemove={removeMember} />
            <MemberGroup title="Viewers" members={viewers} folderId={folderId} onChange={changeRole} onRemove={removeMember} />
          </div>
        ) : null}

        {share.invites.length > 0 ? (
          <div className="stack">
            <h3>Pending invites</h3>
            <ul className="folder-share-list">
              {share.invites.map((item) => (
                <li key={item.id} className="folder-share-row">
                  <SocialAvatar
                    person={{
                      displayName: item.invitee.displayName,
                      username: item.invitee.username,
                      avatarUrl: item.invitee.avatarUrl,
                    }}
                    size="sm"
                  />
                  <span>
                    <strong>{item.invitee.displayName}</strong>
                    <span className="muted">
                      {" "}
                      {folderRoleLabel(item.role)}
                    </span>
                  </span>
                  {item.canRevoke ? (
                    <button type="button" className="btn sm" onClick={() => void revokeInvite(folderId, item.id)}>
                      Revoke
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {share.permissions?.transferOwnership ? (
          <OwnershipSection
            ownerName={share.owner?.displayName ?? "Owner"}
            members={share.members}
            busy={busy}
            onTransfer={async (userId) => {
              setBusy(true);
              const transferred = await transferOwnership(folderId, userId);
              setBusy(false);
              return transferred;
            }}
          />
        ) : null}

        {canInvite ? (
          <div className="stack">
            <h3>Invite people</h3>
            <div className="field">
              <label htmlFor="folder-invite-search">Replayr username</label>
              <input
                id="folder-invite-search"
                value={query}
                placeholder="Search accounts"
                onChange={(event) => {
                  setQuery(event.target.value);
                  setPicked(null);
                }}
              />
            </div>
            {results.length > 0 && !picked ? (
              <ul className="folder-share-list">
                {results.map((user) => (
                  <li key={user.id}>
                    <button type="button" className="folder-share-pick" onClick={() => setPicked(user)}>
                      <SocialAvatar
                        person={{ displayName: user.displayName, username: user.username, avatarUrl: user.avatarUrl }}
                        size="sm"
                      />
                      <span>{user.displayName}</span>
                      {user.username ? <span className="muted">@{user.username}</span> : null}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            {picked ? (
              <p className="muted">
                Inviting <strong>{picked.displayName}</strong>
              </p>
            ) : null}
            <div className="row">
              <label htmlFor="folder-invite-role">Role</label>
              <select
                id="folder-invite-role"
                value={role}
                onChange={(event) => setRole(event.target.value as FolderMemberRole)}
              >
                {share.inviteRoles.map((value) => (
                  <option key={value} value={value}>
                    {folderRoleLabel(value)}
                  </option>
                ))}
              </select>
              <button type="button" className="btn primary" disabled={!picked || busy} onClick={() => void sendInvite()}>
                {busy ? "Sending…" : "Send invite"}
              </button>
            </div>
          </div>
        ) : null}

        <div className="row">
          <button type="button" className="btn" onClick={onClose}>
            Done
          </button>
        </div>
      </section>
    </div>
  );
}

function MemberGroup({
  title,
  members,
  folderId,
  onChange,
  onRemove,
}: {
  title: string;
  members: FolderMember[];
  folderId: string;
  onChange: (folderId: string, userId: string, role: FolderMemberRole) => Promise<void>;
  onRemove: (folderId: string, userId: string) => Promise<void>;
}) {
  if (members.length === 0) return null;
  return (
    <div className="stack">
      <h3>{title}</h3>
      <ul className="folder-share-list">
        {members.map((member) => (
          <li key={member.user.id} className="folder-share-row">
            <SocialAvatar
              person={{
                displayName: member.user.displayName,
                username: member.user.username,
                avatarUrl: member.user.avatarUrl,
              }}
              size="sm"
            />
            <strong>{member.user.displayName}</strong>
            {member.canChangeRole ? (
              <select
                aria-label={`Role for ${member.user.displayName}`}
                value={member.role}
                onChange={(event) => void onChange(folderId, member.user.id, event.target.value as FolderMemberRole)}
              >
                {member.allowedRoles.map((value) => (
                  <option key={value} value={value}>
                    {folderRoleLabel(value)}
                  </option>
                ))}
              </select>
            ) : (
              <span className="badge">{folderRoleLabel(member.role)}</span>
            )}
            {member.canRemove ? (
              <button
                type="button"
                className="btn sm"
                onClick={() => {
                  if (window.confirm(`Remove ${member.user.displayName} from this folder? Clips stay where they are.`)) {
                    void onRemove(folderId, member.user.id);
                  }
                }}
              >
                Remove
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function PublicLinkSection({
  folderId,
  canManage,
  publicShare,
  visibility,
  onEnable,
  onDisable,
  onRegenerate,
  onDownloads,
}: {
  folderId: string;
  canManage: boolean;
  publicShare: { enabled: boolean; url: string | null; allowDownloads: boolean } | null;
  visibility?: string;
  onEnable: () => void;
  onDisable: () => void;
  onRegenerate: () => void;
  onDownloads: (value: boolean) => void;
}) {
  const enabled = publicShare?.enabled ?? visibility === "public_link";
  const displayUrl = publicShare?.url?.replace(/^https?:\/\//, "") ?? null;

  async function copyLink() {
    if (!publicShare?.url) return;
    try {
      await navigator.clipboard.writeText(publicShare.url);
    } catch {
      window.prompt("Copy this public folder link", publicShare.url);
    }
  }

  return (
    <div className="stack folder-public-access">
      <h3>General access</h3>
      {canManage ? (
        <>
          <label className="folder-share-row">
            <input type="radio" name={`folder-access-${folderId}`} checked={!enabled} onChange={onDisable} />
            <span>
              <strong>Private</strong>
              <span className="muted"> Only people with access</span>
            </span>
          </label>
          <label className="folder-share-row">
            <input type="radio" name={`folder-access-${folderId}`} checked={enabled} onChange={onEnable} />
            <span>
              <strong>Public link</strong>
              <span className="muted"> Anyone with the link can view</span>
            </span>
          </label>
          {enabled ? (
            <div className="stack">
              {displayUrl ? <code className="folder-public-url">{displayUrl}</code> : <p className="muted">Public link is on.</p>}
              <div className="row">
                <button type="button" className="btn primary sm" disabled={!publicShare?.url} onClick={() => void copyLink()}>
                  Copy Link
                </button>
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => {
                    if (window.confirm("Anyone using the old link will lose access.")) onRegenerate();
                  }}
                >
                  Regenerate Link
                </button>
                <button type="button" className="btn sm" onClick={onDisable}>
                  Disable Public Link
                </button>
              </div>
              <label className="folder-share-row">
                <input
                  type="checkbox"
                  checked={Boolean(publicShare?.allowDownloads)}
                  onChange={(event) => onDownloads(event.target.checked)}
                />
                <span>Allow downloads</span>
              </label>
            </div>
          ) : null}
        </>
      ) : (
        <p className="muted">{enabled ? "Anyone with the link can view this folder." : "Only people with access can view this folder."}</p>
      )}
    </div>
  );
}

function OwnershipSection({
  ownerName,
  members,
  busy,
  onTransfer,
}: {
  ownerName: string;
  members: FolderMember[];
  busy: boolean;
  onTransfer: (userId: string) => Promise<boolean>;
}) {
  const [picking, setPicking] = useState(false);
  const [target, setTarget] = useState<FolderMember | null>(null);

  async function confirm() {
    if (!target || busy) return;
    const transferred = await onTransfer(target.user.id);
    if (transferred) {
      setTarget(null);
      setPicking(false);
    }
  }

  return (
    <div className="stack folder-ownership">
      <h3>Ownership</h3>
      <p className="muted">
        Owner: <strong>{ownerName}</strong>
      </p>
      {!picking && !target ? (
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => {
            setPicking(true);
            setTarget(null);
          }}
        >
          Transfer ownership
        </button>
      ) : null}
      {picking && !target ? (
        <div className="stack">
          {members.length === 0 ? (
            <p className="muted">Invite someone first. You can only transfer ownership to an active member.</p>
          ) : (
            <>
              <p className="muted">Choose a member</p>
              <ul className="folder-share-list">
                {members.map((member) => (
                  <li key={member.user.id}>
                    <button type="button" className="folder-share-pick" onClick={() => setTarget(member)}>
                      <SocialAvatar
                        person={{
                          displayName: member.user.displayName,
                          username: member.user.username,
                          avatarUrl: member.user.avatarUrl,
                        }}
                        size="sm"
                      />
                      <span>{member.user.displayName}</span>
                      <span className="muted">{folderRoleLabel(member.role)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          <button
            type="button"
            className="btn sm"
            onClick={() => {
              setPicking(false);
              setTarget(null);
            }}
          >
            Cancel
          </button>
        </div>
      ) : null}
      {target ? (
        <div className="stack">
          <p>
            Transfer ownership to <strong>{target.user.displayName}</strong>?
          </p>
          <ul className="folder-ownership-notes">
            <li>{target.user.displayName} becomes Owner</li>
            <li>You become Manager</li>
            <li>Only the new Owner can delete the folder or transfer ownership</li>
          </ul>
          <div className="row">
            <button type="button" className="btn danger" disabled={busy} onClick={() => void confirm()}>
              {busy ? "Transferring…" : `Transfer to ${target.user.displayName}`}
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => {
                setTarget(null);
                setPicking(true);
              }}
            >
              Back
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function PersonRow({ name, user, badge }: { name: string; user: SocialUser; badge: string }) {
  return (
    <div className="folder-share-row">
      <SocialAvatar person={{ displayName: name, username: user.username, avatarUrl: user.avatarUrl }} size="sm" />
      <strong>{name}</strong>
      <span className="badge">{badge}</span>
    </div>
  );
}
