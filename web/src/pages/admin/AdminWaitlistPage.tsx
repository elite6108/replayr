import { useEffect, useMemo, useState } from "react";
import {
  createWaitlistTemplate,
  fetchWaitlist,
  fetchWaitlistCampaigns,
  fetchWaitlistTemplates,
  rewriteWaitlistEmail,
  sendWaitlistCampaign,
  type WaitlistCampaign,
  type WaitlistRow,
  type WaitlistTemplate,
} from "../../lib/admin";
import { useAuth } from "../../lib/auth";
import { formatClipDate } from "../../lib/format";
import { useStaffPermissions } from "../../lib/staff";
import { AdminPageHeader } from "./components/AdminPageHeader";
import { AdminSheet } from "./components/AdminSheet";

export function AdminWaitlistPage() {
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const { can } = useStaffPermissions();
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<WaitlistRow[]>([]);
  const [total, setTotal] = useState(0);
  const [aiEnabled, setAiEnabled] = useState(false);
  const [updates, setUpdates] = useState<{
    announcements: Array<{ title: string; body: string | null }>;
    releases: Array<{ version: string; items: string[] }>;
  }>({ announcements: [], releases: [] });
  const [templates, setTemplates] = useState<WaitlistTemplate[]>([]);
  const [campaigns, setCampaigns] = useState<WaitlistCampaign[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [talkingPoints, setTalkingPoints] = useState("");
  const [goal, setGoal] = useState("");
  const [includeUpdates, setIncludeUpdates] = useState(true);
  const [saveTemplate, setSaveTemplate] = useState(false);
  const [templateName, setTemplateName] = useState("");
  const [busy, setBusy] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);

  async function load() {
    if (!token) return;
    setError(null);
    try {
      const [list, templateList, campaignList] = await Promise.all([
        fetchWaitlist(token, { q: query || undefined }),
        fetchWaitlistTemplates(token),
        fetchWaitlistCampaigns(token),
      ]);
      setItems(list.items);
      setTotal(list.total);
      setAiEnabled(Boolean(list.aiEnabled));
      setUpdates(list.updates ?? { announcements: [], releases: [] });
      setTemplates(templateList.templates);
      setCampaigns(campaignList.campaigns);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load waitlist.");
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const subscribedIds = useMemo(
    () => items.filter((row) => !row.unsubscribedAt).map((row) => row.id),
    [items],
  );
  const selectedCount = [...selected].filter((id) => subscribedIds.includes(id)).length;

  function toggleAll() {
    setSelected((current) => {
      if (current.size === subscribedIds.length) return new Set();
      return new Set(subscribedIds);
    });
  }

  function applyTemplate(template: WaitlistTemplate) {
    setSubject(template.subject);
    setBody(template.body);
    setTemplateName(template.name);
    setComposeOpen(true);
  }

  async function rewrite() {
    if (!token) return;
    if (!goal.trim() && !talkingPoints.trim() && !subject.trim() && !body.trim() && !includeUpdates) {
      setError("Tell the AI what you want, or keep shipped updates on.");
      return;
    }
    setAiBusy(true);
    setError(null);
    try {
      const next = await rewriteWaitlistEmail(token, {
        subject,
        body,
        goal,
        talkingPoints,
        includeUpdates,
      });
      setSubject(next.subject);
      setBody(next.body);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not write that email.");
    } finally {
      setAiBusy(false);
    }
  }

  async function send(audience: "all" | "selected") {
    if (!token) return;
    const count = audience === "all" ? total : selectedCount;
    if (!count) return;
    if (!window.confirm(`Send “${subject}” to ${count} waitlist ${count === 1 ? "email" : "emails"}?`)) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await sendWaitlistCampaign(token, {
        subject,
        body,
        goal,
        talkingPoints,
        includeUpdates,
        audience,
        ids: audience === "selected" ? [...selected] : undefined,
        saveAsTemplate: saveTemplate,
        templateName: templateName || subject,
      });
      setNotice(
        `Queued ${result.campaign.recipientCount} emails. Delivery continues in the background — refresh to see sent counts.`,
      );
      setComposeOpen(false);
      setSelected(new Set());
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not send that campaign.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="admin-dash">
      <AdminPageHeader
        eyebrow="People"
        title="Waitlist"
        description={`${total} emails from coming-soon. AI already has the newest shipped updates — tell it what you want the blast to do.`}
        actions={
          can("waitlist.send") ? (
            <button className="admin-btn primary" type="button" onClick={() => setComposeOpen(true)}>
              Compose
            </button>
          ) : null
        }
      />
      {error ? <p className="error">{error}</p> : null}
      {notice ? <p className="admin-notice">{notice}</p> : null}

      <form
        className="admin-filters"
        onSubmit={(event) => {
          event.preventDefault();
          void load();
        }}
      >
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search email" aria-label="Search waitlist" />
        <button className="admin-btn primary" type="submit">
          Search
        </button>
      </form>

      <section className="admin-panel admin-table-card">
        <header className="admin-panel-head">
          <h3>Subscribers</h3>
          <span className="muted">{selectedCount ? `${selectedCount} selected` : `${items.length} on this page`}</span>
        </header>
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>
                  <input type="checkbox" checked={subscribedIds.length > 0 && selectedCount === subscribedIds.length} onChange={toggleAll} aria-label="Select all on page" />
                </th>
                <th>Email</th>
                <th>Source</th>
                <th>Joined</th>
                <th>Confirmed</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {items.map((row) => (
                <tr key={row.id}>
                  <td>
                    <input
                      type="checkbox"
                      disabled={Boolean(row.unsubscribedAt)}
                      checked={selected.has(row.id)}
                      onChange={() => {
                        setSelected((current) => {
                          const next = new Set(current);
                          if (next.has(row.id)) next.delete(row.id);
                          else next.add(row.id);
                          return next;
                        });
                      }}
                      aria-label={`Select ${row.email}`}
                    />
                  </td>
                  <td>
                    <strong>{row.email}</strong>
                  </td>
                  <td>{row.source}</td>
                  <td>{formatClipDate(row.createdAt)}</td>
                  <td>{row.confirmationSentAt ? formatClipDate(row.confirmationSentAt) : "—"}</td>
                  <td>
                    <span className={`admin-status${row.unsubscribedAt ? " is-inactive" : " is-active"}`}>
                      {row.unsubscribedAt ? "unsubscribed" : "subscribed"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {items.length === 0 ? <p className="muted admin-empty">No waitlist emails yet.</p> : null}
        </div>
      </section>

      {templates.length ? (
        <section className="admin-panel">
          <header className="admin-panel-head">
            <h3>Templates</h3>
          </header>
          <div className="admin-chip-row">
            {templates.map((template) => (
              <button key={template.id} type="button" className="admin-chip" onClick={() => applyTemplate(template)}>
                {template.name}
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {campaigns.length ? (
        <section className="admin-panel admin-table-card">
          <header className="admin-panel-head">
            <h3>Recent campaigns</h3>
          </header>
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Subject</th>
                  <th>Audience</th>
                  <th>Status</th>
                  <th>Sent</th>
                </tr>
              </thead>
              <tbody>
                {campaigns.map((campaign) => (
                  <tr key={campaign.id}>
                    <td>
                      <strong>{campaign.subject}</strong>
                    </td>
                    <td>{campaign.audience}</td>
                    <td>{campaign.status}</td>
                    <td>
                      {campaign.sentCount}/{campaign.recipientCount}
                      {campaign.failedCount ? ` · ${campaign.failedCount} failed` : ""}
                      {campaign.skippedCount ? ` · ${campaign.skippedCount} skipped` : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {composeOpen ? (
        <AdminSheet title="Waitlist blast" subtitle="Newest desktop releases and in-app announcements are loaded automatically. Tell the AI what you want, then send. Every mail still includes replayr.tv, @Replayr_TV, and unsubscribe." onClose={() => setComposeOpen(false)}>
          <form className="admin-form">
            <label>
              What are you looking for?
              <textarea
                rows={3}
                value={goal}
                onChange={(event) => setGoal(event.target.value)}
                placeholder="e.g. Hype cloud screenshots, keep it short, tease that waitlist access is close. Funny, not corporate."
              />
            </label>
            <label>
              Extra facts (optional)
              <textarea
                rows={3}
                value={talkingPoints}
                onChange={(event) => setTalkingPoints(event.target.value)}
                placeholder="Anything not in the update list yet — dates, beta seats, a specific CTA."
              />
            </label>
            <label className="admin-check">
              <input type="checkbox" checked={includeUpdates} onChange={(event) => setIncludeUpdates(event.target.checked)} />
              <span>Use newest shipped updates</span>
            </label>
            {includeUpdates ? (
              <div className="waitlist-updates">
                <strong>Newest updates</strong>
                {updates.releases.length ? (
                  updates.releases.map((release) => (
                    <p key={release.version}>
                      <span className="muted">v{release.version}</span>
                      <br />
                      {release.items.join(" · ")}
                    </p>
                  ))
                ) : (
                  <p className="muted">No release notes loaded yet.</p>
                )}
                {updates.announcements.length ? (
                  <p>
                    {updates.announcements.map((row) => row.title).join(" · ")}
                  </p>
                ) : (
                  <p className="muted">No in-app announcements.</p>
                )}
              </div>
            ) : null}
            {!aiEnabled ? (
              <p className="muted">AI drafts need OPENAI_API_KEY on the Worker. You can still write the subject and body by hand.</p>
            ) : null}
            <div className="admin-row-actions">
              <button
                className="admin-btn primary"
                type="button"
                disabled={aiBusy || busy || !aiEnabled}
                onClick={() => void rewrite()}
              >
                {aiBusy ? "Writing…" : body.trim() ? "Rewrite with AI" : "Write with AI"}
              </button>
            </div>
            <label>
              Subject
              <input value={subject} onChange={(event) => setSubject(event.target.value)} />
            </label>
            <label>
              Body
              <textarea rows={8} value={body} onChange={(event) => setBody(event.target.value)} />
            </label>
            {can("waitlist.templates.manage") ? (
              <label className="admin-check">
                <input type="checkbox" checked={saveTemplate} onChange={(event) => setSaveTemplate(event.target.checked)} />
                <span>Save as template</span>
              </label>
            ) : null}
            {saveTemplate ? (
              <label>
                Template name
                <input value={templateName} onChange={(event) => setTemplateName(event.target.value)} />
              </label>
            ) : null}
          </form>
          <div className="admin-row-actions">
            {can("waitlist.templates.manage") && !saveTemplate ? (
              <button
                className="admin-btn ghost"
                type="button"
                disabled={busy || aiBusy || !subject || !body}
                onClick={() => {
                  const name = window.prompt("Template name", subject);
                  if (!name || !token) return;
                  void createWaitlistTemplate(token, { name, subject, body }).then(load);
                }}
              >
                Save template
              </button>
            ) : null}
            <button className="admin-btn primary" type="button" disabled={busy || aiBusy || !subject || !body} onClick={() => void send("all")}>
              Send to all subscribed
            </button>
            <button className="admin-btn primary" type="button" disabled={busy || aiBusy || !subject || !body || !selectedCount} onClick={() => void send("selected")}>
              Send to selected ({selectedCount})
            </button>
          </div>
        </AdminSheet>
      ) : null}
    </section>
  );
}
