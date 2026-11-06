import { convertFileSrc } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import type { MomentLoop } from "./momentLoop";
import {
  fetchMomentQuota,
  rankClipMoments,
  TRANSCRIPT_LIMIT_MS,
  transcribeClipAudio,
  type MomentFormat,
  type MomentQuota,
  type SuggestedMoment,
} from "../../services/aiMoments";
import { startCheckout } from "../../services/billing";
import { discardTranscriptAudio, extractTranscriptAudio, saveShortClip, saveTrimmedClip } from "../../services/tauri";
import { useAuthStore } from "../../stores/authStore";
import { useBillingStore } from "../../stores/billingStore";
import { useToastStore } from "../../stores/toastStore";
import { formatClock } from "../../utils/format";

type ListedMoment = SuggestedMoment & { checked: boolean };

export function EditorAiPanel({
  localId,
  durationMs,
  pan,
  previewRange,
  onPreviewMoment,
  onStopPreview,
}: {
  localId: string | null;
  durationMs: number;
  pan: number;
  previewRange: MomentLoop | null;
  onPreviewMoment: (startMs: number, endMs: number) => void;
  onStopPreview: () => void;
}) {
  const session = useAuthStore((state) => state.session);
  const premium = useBillingStore((state) => Boolean(state.status?.premium));
  const showToast = useToastStore((state) => state.show);
  const token = session?.access_token ?? "";
  const [quota, setQuota] = useState<MomentQuota | null>(null);
  const [format, setFormat] = useState<MomentFormat>("reel");
  const [transcriptId, setTranscriptId] = useState<string | null>(null);
  const [moments, setMoments] = useState<ListedMoment[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const flight = useRef(false);

  useEffect(() => {
    if (!token) return;
    let cancel = false;
    void fetchMomentQuota(token)
      .then((next) => {
        if (!cancel) setQuota(next);
      })
      .catch(() => undefined);
    return () => {
      cancel = true;
    };
  }, [token]);

  const tooLong = durationMs > TRANSCRIPT_LIMIT_MS;
  const minutes = Math.max(1, Math.ceil(Math.max(0, durationMs) / 60_000));
  const leftMinutes = Math.floor((quota?.transcriptionRemainingSeconds ?? 0) / 60);
  const limitMinutes = Math.floor((quota?.transcriptionLimitSeconds ?? 50 * 60) / 60);
  const shortAllowance = quota != null && quota.transcriptionRemainingSeconds < minutes * 60;

  async function find(nextFormat = format) {
    if (!localId || !token || flight.current) return;
    flight.current = true;
    onStopPreview();
    setBusy(transcriptId ? "Finding moments…" : "Listening for speech…");
    setNote(null);
    try {
      let id = transcriptId;
      if (!id) {
        const audio = await extractTranscriptAudio(localId);
        try {
          const blobs: Blob[] = [];
          for (const part of audio.parts) {
            const response = await fetch(convertFileSrc(part.path));
            if (!response.ok) throw new Error("Could not read the prepared audio.");
            blobs.push(await response.blob());
          }
          const transcript = await transcribeClipAudio(token, blobs);
          id = transcript.transcriptId;
          setTranscriptId(id);
        } finally {
          await discardTranscriptAudio(localId).catch(() => undefined);
        }
      }
      const ranked = await rankClipMoments(token, id, nextFormat);
      setMoments(ranked.map((moment) => ({ ...moment, checked: true })));
      setNote(ranked.length === 0 ? "No speech found in this clip. AI moments need commentary or callouts." : null);
      const fresh = await fetchMomentQuota(token).catch(() => null);
      if (fresh) setQuota(fresh);
    } catch (caught) {
      showToast(caught instanceof Error ? caught.message : "Could not find moments.");
    } finally {
      flight.current = false;
      setBusy(null);
    }
  }

  function chooseFormat(next: MomentFormat) {
    if (next === format || busy) return;
    onStopPreview();
    setFormat(next);
    setMoments([]);
    if (transcriptId) void find(next);
  }

  async function generate() {
    if (!localId || flight.current) return;
    const chosen = moments.filter((moment) => moment.checked);
    if (chosen.length === 0) return;
    flight.current = true;
    setBusy(`Saving 1 of ${chosen.length}`);
    let saved = 0;
    try {
      for (const moment of chosen) {
        setBusy(`Saving ${saved + 1} of ${chosen.length}`);
        const title = moment.title.slice(0, 80);
        if (format === "reel") {
          await saveShortClip(localId, moment.startMs, moment.endMs, pan, title);
        } else {
          await saveTrimmedClip(localId, moment.startMs, moment.endMs, title);
        }
        saved += 1;
      }
      showToast(saved === 1 ? "Saved 1 clip." : `Saved ${saved} clips.`);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Could not save that moment.";
      showToast(saved > 0 ? `Saved ${saved} before the next one failed. ${message}` : message);
    } finally {
      flight.current = false;
      setBusy(null);
    }
  }

  if (!localId) {
    return (
      <>
        <h2>AI moments</h2>
        <p className="editor-later">Open a clip on this PC to find moments.</p>
      </>
    );
  }

  if (!token) {
    return (
      <>
        <h2>AI moments</h2>
        <p className="editor-later">Sign in to use AI moments.</p>
      </>
    );
  }

  if (!premium) {
    return (
      <>
        <h2>AI moments</h2>
        <p className="editor-later">Find spoken moments and save the shorts you want. Premium only.</p>
        <button
          type="button"
          className="btn primary"
          onClick={() => {
            void startCheckout(token, "month", { successUrl: "replayr://billing?status=success" })
              .then((url) => import("@tauri-apps/plugin-opener").then(({ openUrl }) => openUrl(url)))
              .catch((caught: unknown) => showToast(caught instanceof Error ? caught.message : "Could not start checkout."));
          }}
        >
          Upgrade
        </button>
      </>
    );
  }

  return (
    <>
      <h2>AI moments</h2>
      <p className="editor-later">
        This listens for speech, then suggests vertical shorts. A clip with no talking comes back empty.
      </p>
      <p className="editor-later">
        {tooLong
          ? "Trim this clip under 45 minutes first."
          : `Uses about ${minutes} minute${minutes === 1 ? "" : "s"}. ${leftMinutes} of ${limitMinutes} left this month.`}
      </p>
      <div className="editor-speeds" role="group" aria-label="Moment format">
        <button type="button" className={format === "reel" ? "on" : ""} disabled={Boolean(busy)} onClick={() => chooseFormat("reel")}>
          Reel
        </button>
        <button type="button" className={format === "youtube" ? "on" : ""} disabled={Boolean(busy)} onClick={() => chooseFormat("youtube")}>
          YouTube
        </button>
      </div>
      <p className="editor-later">
        {format === "reel"
          ? "9:16, about 20–40 seconds. A 3–5 minute video gets about five. Play one on a loop, then save the ones you want."
          : "Keeps this recording's frame, 20 seconds to 3 minutes."}
      </p>
      <button
        type="button"
        className="btn primary"
        disabled={Boolean(busy) || tooLong || shortAllowance}
        onClick={() => void find()}
      >
        {busy && !busy.startsWith("Saving") ? busy : transcriptId ? "Find again" : "Find moments"}
      </button>
      {shortAllowance ? <p className="editor-later">This clip needs more transcription time than you have left this month.</p> : null}
      {note ? <p className="editor-later">{note}</p> : null}
      {moments.length > 0 ? (
        <ul className="editor-moments">
          {moments.map((moment, index) => {
            const playing = previewRange?.startMs === moment.startMs && previewRange.endMs === moment.endMs;
            return (
              <li key={`${moment.startMs}-${moment.endMs}`} className={playing ? "playing" : undefined}>
                <label>
                  <input
                    type="checkbox"
                    checked={moment.checked}
                    onChange={(event) => {
                      const checked = event.target.checked;
                      setMoments((current) => current.map((item, itemIndex) => (itemIndex === index ? { ...item, checked } : item)));
                    }}
                  />
                  <span>
                    <strong>{moment.title}</strong>
                    <small>
                      {formatClock(moment.startMs)}–{formatClock(moment.endMs)}
                      {moment.reason ? ` · ${moment.reason}` : ""}
                    </small>
                  </span>
                </label>
                <button type="button" className={playing ? "on" : undefined} onClick={() => onPreviewMoment(moment.startMs, moment.endMs)}>
                  {playing ? "Playing" : "Play"}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      {moments.length > 0 ? (
        <button
          type="button"
          className="btn primary"
          disabled={Boolean(busy) || moments.every((moment) => !moment.checked)}
          onClick={() => void generate()}
        >
          {busy?.startsWith("Saving") ? busy : "Save selected"}
        </button>
      ) : null}
    </>
  );
}
