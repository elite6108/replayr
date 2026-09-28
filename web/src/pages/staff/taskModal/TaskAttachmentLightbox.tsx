export function TaskAttachmentLightbox({
  title,
  url,
  mime,
  onClose,
}: {
  title: string;
  url: string;
  mime: string | null;
  onClose: () => void;
}) {
  const image = Boolean(mime?.startsWith("image/"));
  const pdf = mime === "application/pdf";
  return (
    <div className="task-lightbox" role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
      <div className="task-lightbox-card" onClick={(event) => event.stopPropagation()}>
        <header>
          <strong>{title}</strong>
          <button type="button" className="task-modal-ghost sm" onClick={onClose}>
            Close
          </button>
        </header>
        {image ? <img src={url} alt="" /> : null}
        {pdf ? <iframe title={title} src={url} /> : null}
        {!image && !pdf ? (
          <p>
            <a href={url} target="_blank" rel="noreferrer">
              Open signed file
            </a>
          </p>
        ) : null}
      </div>
    </div>
  );
}
