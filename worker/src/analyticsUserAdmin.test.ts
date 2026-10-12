import { describe, expect, it } from "vitest";
import {
  USER_JOURNEY_EXPORT_EVENT_CAP,
  capJourneyEvents,
  resolveJourneyRange,
  safeJourneyProperties,
  timestampRange,
} from "./analyticsUserAdmin";
import {
  renderUserJourneyCsv,
  renderUserJourneyPdf,
  userExportContainsForbidden,
  type UserJourneyExportData,
} from "./analyticsUserExport";
import { AUDIT_ACTIONS, auditActionLabel } from "./audit";

function exportData(overrides: Partial<UserJourneyExportData> = {}): UserJourneyExportData {
  return {
    user: {
      userId: "11111111-1111-4111-8111-111111111111",
      email: "player@example.com",
      username: "player",
      displayName: "Player",
      createdAt: "2026-09-01T00:00:00.000Z",
    },
    range: { from: "2026-09-15T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z" },
    counts: {
      cloudClips: 4,
      screenshots: 3,
      messagesSent: 2,
      conversations: 1,
      foldersOwned: 1,
      foldersShared: 0,
      following: 5,
      followers: 6,
      storageUsedBytes: 1024,
      storageLimitBytes: 2048,
      plan: "pro",
      accountCreatedAt: "2026-09-01T00:00:00.000Z",
    },
    observedActivity: {
      label: "Observed since instrumentation within the selected retention window",
      localClipsSaved: 8,
      localClipsDeleted: 1,
      localScreenshotsCreated: 2,
      localScreenshotsDeleted: 0,
    },
    events: [
      {
        eventName: "clip.saved",
        occurredAt: "2026-09-30T12:00:00.000Z",
        platform: "windows",
        properties: { duration_bucket: "30-60s", cloud_uploaded: false },
      },
    ],
    eventCap: 5_000,
    truncated: false,
    exportedAt: "2026-10-01T12:00:00.000Z",
    ...overrides,
  };
}

describe("named journey serialization", () => {
  it("never returns content or dynamic identifiers", () => {
    expect(
      safeJourneyProperties({
        has_text: true,
        conversation_type: "dm",
        body: "private message",
        title: "private clip",
        path: "C:\\private\\clip.mp4",
        clip_id: "11111111-1111-4111-8111-111111111111",
        recipient_id: "22222222-2222-4222-8222-222222222222",
        storage_key: "users/private.mp4",
      }),
    ).toEqual({ has_text: true, conversation_type: "dm" });
  });

  it("limits journey queries to 30 days", () => {
    expect(() => resolveJourneyRange("2026-08-01T00:00:00Z", "2026-10-01T00:00:00Z")).toThrow(/30 days/);
    expect(resolveJourneyRange("2026-09-15T00:00:00Z", "2026-10-01T00:00:00Z")).toEqual({
      from: "2026-09-15T00:00:00.000Z",
      to: "2026-10-01T00:00:00.000Z",
    });
  });

  it("applies the selected date range to canonical activity timestamps", () => {
    const range = { from: "2026-09-15T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z" };
    expect(timestampRange("created_at", range)).toBe(
      "created_at=gte.2026-09-15T00%3A00%3A00.000Z&created_at=lte.2026-10-01T00%3A00%3A00.000Z",
    );
    expect(timestampRange("joined_at", range)).toContain("joined_at=gte.");
    expect(timestampRange("accepted_at", range)).toContain("accepted_at=lte.");
  });

  it("builds a formula-safe, count-only CSV export", () => {
    const data = exportData({
      user: { ...exportData().user, email: "=IMPORTXML(\"https://bad.example\")" },
    });
    const bytes = renderUserJourneyCsv(data);
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain(`"'=IMPORTXML(""https://bad.example"")"`);
    expect(text).toContain('"period_count","cloudClips","4"');
    expect(text).toContain('"current_snapshot","storageUsedBytes","1024"');
    expect(text).toContain('"event","clip.saved"');
    expect(text).not.toContain(data.user.userId);
    expect(text).not.toContain("private message");
    expect(userExportContainsForbidden(bytes)).toBe(false);
  });

  it("builds a branded PDF without forbidden content", () => {
    const bytes = renderUserJourneyPdf(exportData());
    const text = new TextDecoder().decode(bytes);
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text).toContain("Replayr User Analytics");
    expect(text).toContain("Cloud clips");
    expect(text).not.toContain(exportData().user.userId);
    expect(userExportContainsForbidden(bytes)).toBe(false);
  });

  it("refuses export bytes containing forbidden content markers", () => {
    const data = exportData({
      events: [
        {
          eventName: "message.sent",
          occurredAt: "2026-09-30T12:00:00.000Z",
          platform: "web",
          properties: { reason: "private message" },
        },
      ],
    });
    expect(userExportContainsForbidden(renderUserJourneyCsv(data))).toBe(true);
    expect(userExportContainsForbidden(renderUserJourneyPdf(data))).toBe(true);
  });

  it("caps exports and reports truncation instead of silently over-reading", () => {
    const event = exportData().events[0];
    const result = capJourneyEvents(Array.from({ length: USER_JOURNEY_EXPORT_EVENT_CAP + 1 }, () => event));
    expect(result.events).toHaveLength(USER_JOURNEY_EXPORT_EVENT_CAP);
    expect(result.truncated).toBe(true);
  });

  it("uses a stable, human-readable export audit action", () => {
    expect(AUDIT_ACTIONS.analyticsJourneyExported).toBe("analytics.journey_exported");
    expect(auditActionLabel(AUDIT_ACTIONS.analyticsJourneyExported)).toBe("User journey exported");
  });
});
