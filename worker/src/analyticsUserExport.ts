import { PdfDoc, pdfContainsForbidden } from "./analyticsReportPdf";

export type ExportJourneyEvent = {
  eventName: string;
  occurredAt: string;
  platform: string | null;
  properties: Record<string, string | number | boolean | null>;
};

export type UserJourneyExportData = {
  user: {
    userId: string;
    email: string | null;
    username: string | null;
    displayName: string | null;
    createdAt: string | null;
  };
  range: { from: string; to: string };
  counts: {
    cloudClips: number;
    screenshots: number;
    messagesSent: number;
    conversations: number;
    foldersOwned: number;
    foldersShared: number;
    following: number;
    followers: number;
    storageUsedBytes: number;
    storageLimitBytes: number;
    plan: string;
    accountCreatedAt: string | null;
  };
  observedActivity: {
    label: string;
    localClipsSaved: number;
    localClipsDeleted: number;
    localScreenshotsCreated: number;
    localScreenshotsDeleted: number;
  };
  events: ExportJourneyEvent[];
  eventCap: number;
  truncated: boolean;
  exportedAt: string;
};

const PERIOD_ROWS: Array<[keyof UserJourneyExportData["counts"], string]> = [
  ["cloudClips", "Cloud clips created"],
  ["screenshots", "Screenshots created"],
  ["messagesSent", "Messages sent"],
  ["conversations", "Conversations joined"],
  ["foldersOwned", "Folders created"],
  ["foldersShared", "Folder shares joined"],
  ["following", "Accounts followed"],
  ["followers", "New followers"],
];

const SNAPSHOT_ROWS: Array<[keyof UserJourneyExportData["counts"], string]> = [
  ["storageUsedBytes", "Cloud storage used (bytes)"],
  ["storageLimitBytes", "Cloud storage limit (bytes)"],
  ["plan", "Plan"],
];

const ACTIVITY_ROWS: Array<[keyof UserJourneyExportData["observedActivity"], string]> = [
  ["localClipsSaved", "Local clips saved"],
  ["localClipsDeleted", "Local clips deleted"],
  ["localScreenshotsCreated", "Local screenshots created"],
  ["localScreenshotsDeleted", "Local screenshots deleted"],
];

export function renderUserJourneyCsv(data: UserJourneyExportData): Uint8Array {
  const rows: unknown[][] = [
    ["record_type", "key", "value", "occurred_at", "platform", "properties"],
    ["metadata", "email", data.user.email ?? "", "", "", ""],
    ["metadata", "username", data.user.username ?? "", "", "", ""],
    ["metadata", "display_name", data.user.displayName ?? "", "", "", ""],
    ["metadata", "account_created_at", data.user.createdAt ?? "", "", "", ""],
    ["metadata", "range_from", data.range.from, "", "", ""],
    ["metadata", "range_to", data.range.to, "", "", ""],
    ["metadata", "exported_at", data.exportedAt, "", "", ""],
    ["metadata", "event_cap", data.eventCap, "", "", ""],
    ["metadata", "events_truncated", data.truncated, "", "", ""],
  ];

  for (const [key] of PERIOD_ROWS) {
    rows.push(["period_count", key, data.counts[key] ?? "", "", "", ""]);
  }
  for (const [key] of SNAPSHOT_ROWS) {
    rows.push(["current_snapshot", key, data.counts[key] ?? "", "", "", ""]);
  }
  for (const [key] of ACTIVITY_ROWS) {
    rows.push(["observed_activity", key, data.observedActivity[key], "", "", ""]);
  }
  for (const event of data.events) {
    rows.push([
      "event",
      event.eventName,
      "",
      event.occurredAt,
      event.platform ?? "",
      JSON.stringify(event.properties),
    ]);
  }

  const csv = rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
  return new TextEncoder().encode(`\uFEFF${csv}\r\n`);
}

export function renderUserJourneyPdf(data: UserJourneyExportData): Uint8Array {
  const displayName =
    data.user.displayName || (data.user.username ? `@${data.user.username}` : null) || data.user.email || "Replayr user";
  const doc = new PdfDoc(`${displayName} · Count-only user analytics · Replayr`);
  doc.y = 700;
  doc.text(48, doc.y, "Replayr User Analytics", { size: 22, bold: true });
  doc.y -= 24;
  doc.text(48, doc.y, displayName, { size: 14 });
  doc.y -= 18;
  doc.para(`Range ${displayDate(data.range.from)} through ${displayDate(data.range.to)} · Exported ${displayDate(data.exportedAt)}`);
  doc.para("This report contains date-scoped activity counts, a current account snapshot, and count-only journey events. It excludes clip, screenshot, message, filename, path, and storage-object content.");

  doc.heading("Account");
  doc.table(
    ["Field", "Value"],
    [
      ["Email", data.user.email ?? "—"],
      ["Username", data.user.username ? `@${data.user.username}` : "—"],
      ["Created", displayDate(data.user.createdAt)],
    ],
  );

  doc.heading("Selected period activity");
  doc.table(
    ["Metric", "Value"],
    PERIOD_ROWS.map(([key, label]) => [label, printable(data.counts[key])]),
  );

  doc.heading("Current account snapshot");
  doc.para("These values are current and are not reconstructed historically.");
  doc.table(
    ["Metric", "Value"],
    SNAPSHOT_ROWS.map(([key, label]) => [label, printable(data.counts[key])]),
  );

  doc.heading("Observed offline activity");
  doc.para(data.observedActivity.label);
  doc.table(
    ["Metric", "Value"],
    ACTIVITY_ROWS.map(([key, label]) => [label, printable(data.observedActivity[key])]),
  );

  const pdfEvents = data.events.slice(0, 250);
  doc.heading("Recent count-only journey");
  if (pdfEvents.length === 0) {
    doc.para("No consented journey events were observed in this retention window.");
  } else {
    doc.table(
      ["Time", "Event", "Platform", "Properties"],
      pdfEvents.map((event) => [
        event.occurredAt.slice(0, 19).replace("T", " "),
        event.eventName,
        event.platform ?? "—",
        propertyText(event.properties),
      ]),
    );
  }
  if (data.events.length > pdfEvents.length || data.truncated) {
    doc.para(
      `The PDF shows ${pdfEvents.length} recent events. Use the CSV for the complete bounded export${
        data.truncated ? `; the export is capped at ${data.eventCap} events` : ""
      }.`,
    );
  }

  return doc.build();
}

export function userExportContainsForbidden(bytes: Uint8Array): boolean {
  if (pdfContainsForbidden(bytes)) return true;
  const text = new TextDecoder().decode(bytes);
  return /private message|storage_key|object_key|thumbnail_key|clip_id|recipient_id|file_path|local_path/i.test(text);
}

function csvCell(value: unknown): string {
  let text = value == null ? "" : String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function propertyText(properties: ExportJourneyEvent["properties"]): string {
  const entries = Object.entries(properties);
  return entries.length === 0 ? "—" : entries.map(([key, value]) => `${key}: ${String(value)}`).join(" · ");
}

function printable(value: unknown): string {
  if (value == null || value === "") return "—";
  return String(value);
}

function displayDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}
