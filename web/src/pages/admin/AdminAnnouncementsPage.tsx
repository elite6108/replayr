import { FormEvent, useEffect, useState } from "react";
import {
  deleteAdminAnnouncement,
  fetchAdminAnnouncements,
  saveAdminAnnouncement,
  uploadAnnouncementImage,
  type AdminAnnouncement,
  type AnnouncementAudience,
  type AnnouncementDismiss,
  type AnnouncementFrequency,
  type AnnouncementPlacement,
} from "../../lib/announcements";
import { useAuth } from "../../lib/auth";
import { formatClipDate } from "../../lib/format";

interface Draft {
  title: string;
  body: string;
  imageUrl: string;
  ctaLabel: string;
  ctaUrl: string;
  placement: AnnouncementPlacement;
  showDesktop: boolean;
  showWeb: boolean;
  showMobile: boolean;
  audience: AnnouncementAudience;
  startsAt: string;
  endsAt: string;
  frequency: AnnouncementFrequency;
  intervalHours: string;
  maxImpressions: string;
  dismissBehavior: AnnouncementDismiss;
  dismissible: boolean;
  priority: string;
  enabled: boolean;
}

const emptyDraft: Draft = {
  title: "",
  body: "",
  imageUrl: "",
  ctaLabel: "Learn more",
  ctaUrl: "",
  placement: "modal",
  showDesktop: true,
  showWeb: true,
  showMobile: true,
  audience: "all",
  startsAt: "",
  endsAt: "",
  frequency: "once",
  intervalHours: "24",
  maxImpressions: "",
  dismissBehavior: "forever",
  dismissible: true,
  priority: "0",
  enabled: false,
};

export function AdminAnnouncementsPage() {
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const [items, setItems] = useState<AdminAnnouncement[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null | "new">(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState<File | null>(null);

  async function load() {
    if (!token) return;
    setError(null);
    try {
      setItems(await fetchAdminAnnouncements(token));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load announcements.");
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  function beginNew() {
    setEditingId("new");
    setDraft({ ...emptyDraft, startsAt: toLocalInput(new Date().toISOString()) });
    setFile(null);
    setNotice(null);
  }

  function beginEdit(row: AdminAnnouncement) {
    setEditingId(row.id);
    setDraft({
      title: row.title,
      body: row.body || "",
      imageUrl: row.imageUrl || "",
      ctaLabel: row.ctaLabel || "",
      ctaUrl: row.ctaUrl || "",
      placement: row.placement,
      showDesktop: row.showDesktop,
      showWeb: row.showWeb,
      showMobile: row.showMobile,
      audience: row.audience,
      startsAt: toLocalInput(row.startsAt),
      endsAt: toLocalInput(row.endsAt),
      frequency: row.frequency,
      intervalHours: String(row.intervalHours || 24),
      maxImpressions: row.maxImpressions ? String(row.maxImpressions) : "",
      dismissBehavior: row.dismissBehavior,
      dismissible: row.dismissible,
      priority: String(row.priority ?? 0),
      enabled: row.enabled,
    });
    setFile(null);
    setNotice(null);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const startsAt = draft.startsAt ? new Date(draft.startsAt) : new Date();
      const endsAt = draft.endsAt ? new Date(draft.endsAt) : null;
      if (endsAt && endsAt.getTime() <= startsAt.getTime()) {
        setError("End date must be after the start date.");
        setBusy(false);
        return;
      }
      const payload = {
        title: draft.title,
        body: draft.body || null,
        imageUrl: draft.imageUrl || null,
        ctaLabel: draft.ctaLabel || null,
        ctaUrl: draft.ctaUrl || null,
        placement: draft.placement,
        showDesktop: draft.showDesktop,
        showWeb: draft.showWeb,
        showMobile: draft.showMobile,
        audience: draft.audience,
        startsAt: startsAt.toISOString(),
        endsAt: endsAt ? endsAt.toISOString() : null,
        frequency: draft.frequency,
        intervalHours: Number(draft.intervalHours) || 24,
        maxImpressions: draft.maxImpressions ? Number(draft.maxImpressions) : null,
        dismissBehavior: draft.dismissBehavior,
        dismissible: draft.dismissible,
        priority: Number(draft.priority) || 0,
        enabled: draft.enabled,
      };
      let saved = await saveAdminAnnouncement(token, payload, editingId === "new" ? undefined : editingId || undefined);
      if (file) {
        saved = await uploadAnnouncementImage(token, saved.id, file);
        setFile(null);
      }
      setNotice(
        saved.enabled
          ? "Announcement is live. Open the homepage or desktop app (not Admin) to see it."
          : "Saved as a draft — check “Publish live” and save again to show it.",
      );
      setEditingId(saved.id);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save that announcement.");
    } finally {
      setBusy(false);
    }
  }

  async function toggleEnabled(row: AdminAnnouncement) {
    if (!token) return;
    try {
      await saveAdminAnnouncement(token, { enabled: !row.enabled }, row.id);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update that announcement.");
    }
  }

  async function remove(row: AdminAnnouncement) {
    if (!token) return;
    if (!window.confirm(`Delete “${row.title}”? People will stop seeing it immediately.`)) return;
    try {
      await deleteAdminAnnouncement(token, row.id);
      if (editingId === row.id) {
        setEditingId(null);
        setDraft(emptyDraft);
      }
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not delete that announcement.");
    }
  }

  const preview = editingId
    ? items.find((row) => row.id === editingId)?.uploadedImageUrl || draft.imageUrl
    : null;

  return (
    <section className="admin-section">
      <header className="admin-header">
        <div>
          <p className="eyebrow">Reach</p>
          <h2>Announcements</h2>
          <p className="muted">
            Banners and popups on the Windows app, website, and mobile. Schedule a window, repeat through the day,
            and attach a message, image, and link.
          </p>
        </div>
        <button className="btn primary" type="button" onClick={beginNew}>
          New announcement
        </button>
      </header>
      {error ? <p className="error">{error}</p> : null}
      {notice ? <p className="ok">{notice}</p> : null}

      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Announcement</th>
              <th>When</th>
              <th>Where</th>
              <th>Repeat</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr>
                <td colSpan={5} className="muted">
                  No announcements yet.
                </td>
              </tr>
            ) : (
              items.map((row) => (
                <tr key={row.id}>
                  <td>
                    <strong>{row.title}</strong>
                    <div className="muted">
                      {row.enabled ? "Live" : "Draft"} · {row.placement === "modal" ? "Popup" : "Banner"} · {audienceLabel(row.audience)}
                    </div>
                  </td>
                  <td>
                    {formatClipDate(row.startsAt)}
                    {row.endsAt ? ` → ${formatClipDate(row.endsAt)}` : " → open"}
                  </td>
                  <td className="muted">
                    {[row.showDesktop && "Desktop", row.showWeb && "Web", row.showMobile && "Mobile"]
                      .filter(Boolean)
                      .join(" · ") || "None"}
                  </td>
                  <td className="muted">{frequencyLabel(row)}</td>
                  <td>
                    <div className="admin-filters">
                      <button className="btn sm" type="button" onClick={() => beginEdit(row)}>
                        Edit
                      </button>
                      <button className="btn sm" type="button" onClick={() => void toggleEnabled(row)}>
                        {row.enabled ? "Disable" : "Enable"}
                      </button>
                      <button className="btn sm danger" type="button" onClick={() => void remove(row)}>
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {editingId ? (
        <form className="announce-admin-form" onSubmit={(event) => void save(event)}>
          <h3>{editingId === "new" ? "New announcement" : "Edit announcement"}</h3>
          <label>
            Title
            <input
              required
              maxLength={120}
              value={draft.title}
              onChange={(event) => setDraft({ ...draft, title: event.target.value })}
            />
          </label>
          <label>
            Message
            <textarea
              rows={4}
              maxLength={2000}
              value={draft.body}
              onChange={(event) => setDraft({ ...draft, body: event.target.value })}
              placeholder="What’s new, a short recap, or a call to try a feature."
            />
          </label>
          <div className="announce-admin-grid">
            <label>
              Image URL
              <input
                value={draft.imageUrl}
                onChange={(event) => setDraft({ ...draft, imageUrl: event.target.value })}
                placeholder="https://…"
              />
            </label>
            <label>
              Or upload an image
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              />
            </label>
          </div>
          {preview ? <img className="announce-admin-preview" src={preview} alt="" /> : null}
          <div className="announce-admin-grid">
            <label>
              Button label
              <input
                maxLength={40}
                value={draft.ctaLabel}
                onChange={(event) => setDraft({ ...draft, ctaLabel: event.target.value })}
                placeholder="Learn more"
              />
            </label>
            <label>
              Button link
              <input
                value={draft.ctaUrl}
                onChange={(event) => setDraft({ ...draft, ctaUrl: event.target.value })}
                placeholder="https://replayr.tv/pricing or /pricing"
              />
            </label>
          </div>
          <div className="announce-admin-grid">
            <label>
              Style
              <select
                value={draft.placement}
                onChange={(event) => setDraft({ ...draft, placement: event.target.value as AnnouncementPlacement })}
              >
                <option value="modal">Popup</option>
                <option value="banner">Banner</option>
              </select>
            </label>
            <label>
              Audience
              <select
                value={draft.audience}
                onChange={(event) => setDraft({ ...draft, audience: event.target.value as AnnouncementAudience })}
              >
                <option value="all">Everyone</option>
                <option value="signed_out">Signed out</option>
                <option value="signed_in">Signed in</option>
                <option value="free">Free plan</option>
                <option value="premium">Premium</option>
              </select>
            </label>
            <label>
              Priority
              <input
                type="number"
                min={-100}
                max={100}
                value={draft.priority}
                onChange={(event) => setDraft({ ...draft, priority: event.target.value })}
              />
            </label>
          </div>
          <fieldset className="announce-check-row">
            <legend>Show on</legend>
            <label>
              <input
                type="checkbox"
                checked={draft.showDesktop}
                onChange={(event) => setDraft({ ...draft, showDesktop: event.target.checked })}
              />
              Desktop
            </label>
            <label>
              <input
                type="checkbox"
                checked={draft.showWeb}
                onChange={(event) => setDraft({ ...draft, showWeb: event.target.checked })}
              />
              Website
            </label>
            <label>
              <input
                type="checkbox"
                checked={draft.showMobile}
                onChange={(event) => setDraft({ ...draft, showMobile: event.target.checked })}
              />
              Mobile
            </label>
          </fieldset>
          <div className="announce-admin-grid">
            <label>
              Starts
              <input
                type="datetime-local"
                value={draft.startsAt}
                onChange={(event) => setDraft({ ...draft, startsAt: event.target.value })}
              />
            </label>
            <label>
              Ends (optional)
              <input
                type="datetime-local"
                value={draft.endsAt}
                onChange={(event) => setDraft({ ...draft, endsAt: event.target.value })}
              />
            </label>
          </div>
          <div className="announce-admin-grid">
            <label>
              How often
              <select
                value={draft.frequency}
                onChange={(event) => setDraft({ ...draft, frequency: event.target.value as AnnouncementFrequency })}
              >
                <option value="once">Once, until they dismiss</option>
                <option value="every_session">Every app/browser session</option>
                <option value="interval">Every few hours</option>
              </select>
            </label>
            <label>
              Hours between shows
              <input
                type="number"
                min={1}
                max={720}
                value={draft.intervalHours}
                disabled={draft.frequency !== "interval"}
                onChange={(event) => setDraft({ ...draft, intervalHours: event.target.value })}
              />
            </label>
            <label>
              Max times per person
              <input
                type="number"
                min={1}
                max={100}
                value={draft.maxImpressions}
                onChange={(event) => setDraft({ ...draft, maxImpressions: event.target.value })}
                placeholder="Unlimited"
              />
            </label>
          </div>
          <div className="announce-admin-grid">
            <label>
              After they close it
              <select
                value={draft.dismissBehavior}
                onChange={(event) => setDraft({ ...draft, dismissBehavior: event.target.value as AnnouncementDismiss })}
              >
                <option value="forever">Don’t show again</option>
                <option value="snooze">Bring it back later</option>
              </select>
            </label>
            <label className="announce-check-single">
              <input
                type="checkbox"
                checked={draft.dismissible}
                onChange={(event) => setDraft({ ...draft, dismissible: event.target.checked })}
              />
              Allow dismiss
            </label>
            <label className="announce-check-single">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
              />
              Publish live (required to show on homepage / desktop)
            </label>
          </div>
          <div className="announce-admin-actions">
            <button className="btn primary" type="submit" disabled={busy}>
              {busy ? "Saving…" : draft.enabled ? "Save & publish" : "Save draft"}
            </button>
            <button
              className="btn"
              type="button"
              onClick={() => {
                setEditingId(null);
                setFile(null);
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}
    </section>
  );
}

function audienceLabel(audience: AnnouncementAudience) {
  if (audience === "signed_out") return "Signed out";
  if (audience === "signed_in") return "Signed in";
  if (audience === "free") return "Free";
  if (audience === "premium") return "Premium";
  return "Everyone";
}

function frequencyLabel(row: AdminAnnouncement) {
  if (row.frequency === "every_session") return "Each session";
  if (row.frequency === "interval") return `Every ${row.intervalHours}h`;
  return "Once";
}

function toLocalInput(value: string | null | undefined) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
