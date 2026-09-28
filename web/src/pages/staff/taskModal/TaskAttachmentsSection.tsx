import { useEffect, useId, useState } from "react";
import { fetchStaffAttachmentUrl } from "../../../lib/staff";
import { formatBytes } from "../../../lib/format";
import { IconCloudUpload, IconPaperclip, IconTrash } from "../opsIcons";

export type StaffAttachmentItem = {
  id: string;
  filename: string;
  mime: string | null;
  bytes: number | null;
  createdAt?: string;
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
  const [over, setOver] = useState(false);
  const inputId = useId();

  function takeFiles(list: FileList | File[]) {
    for (const file of Array.from(list)) onPick(file);
  }

  return (
    <section className="task-modal-card task-modal-card-attach" style={{ gridArea: "attach" }}>
      <header className="task-modal-card-head">
        <IconPaperclip />
        <div>
          <h3>Attachments</h3>
        </div>
        <span className="task-modal-count">{attachments.length}</span>
      </header>
      {canUpload ? (
        <div className="task-attach-pick">
          <label
            htmlFor={inputId}
            className={`task-attach-drop${over ? " is-over" : ""}`}
            onDragOver={(event) => {
              event.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(event) => {
              event.preventDefault();
              setOver(false);
              if (event.dataTransfer.files.length) takeFiles(event.dataTransfer.files);
            }}
          >
            <IconCloudUpload />
            <strong>
              Drag and drop files here
              <span> or click to browse</span>
            </strong>
            <em>Supports images, PDFs, and text (max 25 MB)</em>
          </label>
          <input
            id={inputId}
            className="task-attach-input"
            type="file"
            accept="image/jpeg,image/png,image/webp,application/pdf,text/plain,.log"
            onChange={(event) => {
              const input = event.currentTarget;
              const picked = input.files ? Array.from(input.files) : [];
              input.value = "";
              if (picked.length) takeFiles(picked);
            }}
          />
        </div>
      ) : null}
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
                    {file.bytes ? formatBytes(file.bytes) : kindLabel(file.mime, file.filename)}
                    {file.createdAt ? ` · ${formatAttachDate(file.createdAt)}` : ""}
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
      {kindLabel(file.mime, file.filename).slice(0, 4)}
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

function formatAttachDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
