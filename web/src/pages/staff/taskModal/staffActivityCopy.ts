import type { StaffActorCard } from "../../../lib/staff";

export function activityHeadline(
  item: {
    action: string;
    metadata: Record<string, unknown>;
    actor?: StaffActorCard | null;
  },
): string {
  const name = item.actor?.displayName || "Someone";
  const meta = item.metadata ?? {};
  switch (item.action) {
    case "created":
      return `${name} created this card`;
    case "updated":
      return `${name} updated ${changedFields(meta)}`;
    case "moved":
      return `${name} moved this card`;
    case "assigned":
      return `${name} changed assignees`;
    case "commented":
      return `${name} commented`;
    case "comment_edited":
      return `${name} edited a comment`;
    case "comment_deleted":
      return `${name} deleted a comment`;
    case "attachment":
      return `${name} attached ${typeof meta.filename === "string" ? meta.filename : "a file"}`;
    case "attachment_deleted":
      return `${name} removed ${typeof meta.filename === "string" ? meta.filename : "an attachment"}`;
    case "checklist":
      return `${name} added a checklist`;
    case "archived":
      return `${name} archived this card`;
    default:
      return `${name} ${item.action.replace(/_/g, " ")}`;
  }
}

function changedFields(metadata: Record<string, unknown>): string {
  const after = metadata.after && typeof metadata.after === "object" ? Object.keys(metadata.after as object) : [];
  if (!after.length) return "the card";
  return after.join(", ");
}
