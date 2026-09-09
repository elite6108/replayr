const message = "Changing bitrate automatically restarts Instant Replay and clears unsaved buffered footage. Save any clip you want first. An active recording or clip save finishes before the restart. Saved clips are never deleted. Custom bitrate applies when you press Enter or leave the field.";

export function BitrateChangeInfo() {
  return (
    <details style={{ display: "inline-block", marginLeft: 6 }}>
      <summary aria-label="How bitrate changes affect Instant Replay" title={message} style={{ cursor: "help" }}>ⓘ</summary>
      <small className="muted">{message}</small>
    </details>
  );
}
