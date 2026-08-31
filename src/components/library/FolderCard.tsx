import { Link } from "react-router-dom";
import { folderAccessLabel, folderRoleLabel } from "../../services/api.folders";
import type { Folder } from "../../services/social-types";
import { SocialAvatar } from "../common/SocialAvatar";

export function FolderCard({ folder, shared = false }: { folder: Folder; shared?: boolean }) {
  const label = folder.clipCount === 1 ? "1 clip" : `${folder.clipCount} clips`;
  const role =
    folder.role === "manager" || folder.role === "editor" || folder.role === "viewer"
      ? folderRoleLabel(folder.role)
      : null;
  return (
    <Link className="folder-card" to={`/library/folders/${folder.id}`}>
      <div className="folder-card-cover">
        {folder.coverThumbnailUrl ? <img src={folder.coverThumbnailUrl} alt="" /> : <span>Folder</span>}
      </div>
      <div className="folder-card-meta">
        <strong>{folder.name}</strong>
        <span className="muted">
          {label}
          {shared && folder.owner ? (
            <>
              <span aria-hidden="true"> · </span>
              {folder.owner.displayName}
            </>
          ) : null}
          <span aria-hidden="true"> · </span>
          {folderAccessLabel(folder)}
        </span>
        {shared && role ? <span className="badge">{role}</span> : null}
        {shared && folder.membersPreview.length > 0 ? (
          <div className="folder-card-avatars" aria-label="Members">
            {folder.membersPreview.map((person) => (
              <SocialAvatar
                key={person.id}
                person={{ displayName: person.displayName, username: person.username, avatarUrl: person.avatarUrl }}
                size="sm"
              />
            ))}
          </div>
        ) : null}
      </div>
    </Link>
  );
}
