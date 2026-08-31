import { convertFileSrc } from "@tauri-apps/api/core";
import { useMemo, useState } from "react";
import { findLinkedCloudClip, isLocalClipInCloud } from "../../utils/clips";
import { formatClipDate, formatDuration } from "../../utils/format";
import { useCloudStore } from "../../stores/cloudStore";
import { useLibraryStore } from "../../stores/libraryStore";
import { useToastStore } from "../../stores/toastStore";
import type { CloudClip, LocalClip } from "../../types/clip";

function localThumb(clip: LocalClip | undefined): string | null {
  const path = clip?.thumbnailPath || (clip?.filePath.match(/\.(bmp|png|jpe?g|webp)$/i) ? clip.filePath : null);
  return path ? convertFileSrc(path) : null;
}

export function AddClipsSheet({
  existingIds,
  onAdd,
  onClose,
}: {
  existingIds: string[];
  onAdd: (clipIds: string[]) => Promise<void>;
  onClose: () => void;
}) {
  const cloudClips = useCloudStore((state) => state.clips);
  const localClips = useLibraryStore((state) => state.clips);
  const upload = useLibraryStore((state) => state.upload);
  const showToast = useToastStore((state) => state.show);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const inFolder = useMemo(() => new Set(existingIds), [existingIds]);
  const ready = cloudClips.filter((clip) => clip.status === "ready" && !inFolder.has(clip.id));
  const localOnly = localClips.filter((clip) => !isLocalClipInCloud(clip, cloudClips));
  const localByCloudId = useMemo(() => {
    const map = new Map<string, LocalClip>();
    for (const clip of localClips) {
      const linked = findLinkedCloudClip(clip, cloudClips);
      if (linked) map.set(linked.id, clip);
      else if (clip.cloudClipId) map.set(clip.cloudClipId, clip);
    }
    return map;
  }, [cloudClips, localClips]);

  function toggle(clip: CloudClip) {
    setPicked((current) => (current.includes(clip.id) ? current.filter((id) => id !== clip.id) : [...current, clip.id]));
  }

  async function add() {
    if (picked.length === 0) return;
    setBusy(true);
    try {
      await onAdd(picked);
      onClose();
    } catch {
      /* toast handled by store */
    } finally {
      setBusy(false);
    }
  }

  function uploadLocal(clip: LocalClip) {
    void upload(clip.localId);
    showToast("Upload this clip to share it in the folder.");
  }

  return (
    <div className="send-overlay" role="dialog" aria-modal="true" aria-label="Add clips">
      <button type="button" className="player-backdrop" aria-label="Close" onClick={onClose} />
      <section className="send-sheet add-clips-sheet">
        <h2>Add clips</h2>
        <p className="muted">Cloud clips only. Adding a clip does not copy the file or change ownership.</p>
        <div className="add-clips-body">
          <div className="stack">
            <h3>Cloud</h3>
            {ready.length === 0 ? (
              <p className="muted">No ready cloud clips left to add.</p>
            ) : (
              <ul className="add-clips-list">
                {ready.map((clip) => {
                  const selected = picked.includes(clip.id);
                  const local = localByCloudId.get(clip.id);
                  const thumb = localThumb(local);
                  return (
                    <li key={clip.id}>
                      <label className={`add-clip-row ${selected ? "is-picked" : ""}`}>
                        <input type="checkbox" checked={selected} onChange={() => toggle(clip)} />
                        <span className="add-clip-thumb">
                          {thumb ? <img src={thumb} alt="" /> : <span>Clip</span>}
                        </span>
                        <span className="add-clip-copy">
                          <strong>{clip.title || "Untitled clip"}</strong>
                          <span className="muted">
                            {formatClipDate(local?.createdAt ?? clip.createdAt)}
                            {clip.durationMs ? ` · ${formatDuration(clip.durationMs)}` : ""}
                          </span>
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          {localOnly.length > 0 ? (
            <div className="stack">
              <h3>On this PC only</h3>
              <p className="muted">Upload this clip to share it in the folder.</p>
              <ul className="add-clips-list">
                {localOnly.map((clip) => {
                  const thumb = localThumb(clip);
                  return (
                  <li key={clip.localId} className="add-clip-row">
                    <span className="add-clip-thumb">
                      {thumb ? <img src={thumb} alt="" /> : <span>Clip</span>}
                    </span>
                    <span className="add-clip-copy">
                      <strong>{clip.title || "Untitled clip"}</strong>
                      <span className="muted">
                        {formatClipDate(clip.createdAt)}
                        {clip.durationMs ? ` · ${formatDuration(clip.durationMs)}` : ""}
                      </span>
                    </span>
                    <button type="button" className="btn sm" onClick={() => uploadLocal(clip)}>
                      Upload
                    </button>
                  </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
        </div>
        <div className="row">
          <button type="button" className="btn primary" disabled={picked.length === 0 || busy} onClick={() => void add()}>
            {busy ? "Adding…" : `Add ${picked.length || ""}`.trim()}
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </section>
    </div>
  );
}
