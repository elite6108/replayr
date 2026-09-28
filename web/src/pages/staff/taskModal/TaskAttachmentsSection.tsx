import { useEffect, useState } from "react";
import { fetchStaffAttachmentUrl } from "../../../lib/staff";
import { formatBytes } from "../../../lib/format";
import { IconPaperclip, IconPlus, IconTrash } from "../opsIcons";

export type StaffAttachmentItem = {
  id: string;
  filename: string;
  mime: string | null;
  bytes: number | null;
};

export function TaskAttachmentsSection({
  token,
  attachments,
  uploadLabel,
  canUpload,
  canDelete,
  onPick,
  onOpen,
  onDelete,
}: {
  token: string;
  attachments: StaffAttachmentItem[];
  uploadLabel: string | null;
  canUpload: boolean;
  canDelete: boolean;
  onPick: (file: File) => void;
  onOpen: (file: StaffAttachmentItem) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <section className="task-modal-extra">
      <h4>Attachments</h4>
      {uploadLabel ? (
        <div className="task-attach-progress" role="status">
          <span>{uploadLabel}</span>
          <span className="task-attach-progress-bar" />
        </div>
      ) : null}
      {attachments.length ? (
        <ul className="task-attach-list">
          {attachments.map((file) => (
            <li key={file.id}>
              <button type="button" className="task-attach-card" onClick={() => onOpen(file)}>
                <AttachmentThumb token={token} file={file} />
                <span className="task-attach-meta">
                  <strong>{file.filename}</strong>
                  <span>
                    {kindLabel(file.mime, file.filename)}
                    {file.bytes ? ` · ${formatBytes(file.bytes)}` : ""}
                  </span>
                </span>
              </button>
              {canDelete ? (
                <button
                  type="button"
                  className="task-attach-remove"
                  aria-label={`Remove ${file.filename}`}
                  onClick={() => onDelete(file.id)}
                >
                  <IconTrash />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {canUpload ? (
        <label className="task-attach-add">
          <IconPlus width="14" height="14" />
          Add file
          <input
            type="file"
            hidden
            accept="image/jpeg,image/png,image/webp,application/pdf,text/plain,.log"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.currentTarget.value = "";
              if (file) onPick(file);
            }}
          />
        </label>
      ) : null}
    </section>
  );
}

function AttachmentThumb({ token, file }: { token: string; file: StaffAttachmentItem }) {
  const [src, setSrc] = useState<string | null>(null);
  const image = Boolean(file.mime?.startsWith("image/"));
  useEffect(() => {
    if (!image || !token) return;
    let cancelled = false;
    void fetchStaffAttachmentUrl(token, file.id)
      .then((body) => {
        if (!cancelled) setSrc(body.url);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [file.id, image, token]);
  if (src) return <img className="task-attach-thumb" src={src} alt="" />;
  return (
    <span className={`task-attach-badge is-${kindClass(file.mime)}`}>
      {image ? <IconPaperclip /> : kindLabel(file.mime, file.filename).slice(0, 4)}
    </span>
  );
}

function kindLabel(mime: string | null, filename: string) {
  if (mime?.startsWith("image/")) return mime.replace("image/", "").toUpperCase();
  if (mime === "application/pdf") return "PDF";
  const ext = filename.split(".").pop()?.toUpperCase();
  return ext && ext.length <= 4 ? ext : "FILE";
}

function kindClass(mime: string | null) {
  if (mime?.startsWith("image/")) return "image";
  if (mime === "application/pdf") return "pdf";
  return "file";
}
