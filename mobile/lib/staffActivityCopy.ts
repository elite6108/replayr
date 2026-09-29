export function activityHeadline(
  item: {
    action: string;
    metadata: Record<string, unknown>;
  },
  columns?: Array<{ id: string; name: string }>,
): string {
  const meta = item.metadata ?? {};
  switch (item.action) {
    case "created":
      return "Task created";
    case "updated": {
      const after = meta.after && typeof meta.after === "object" ? Object.keys(meta.after as object) : [];
      return after.length ? `Updated ${after.join(", ")}` : "Task updated";
    }
    case "moved": {
      const columnId = typeof meta.columnId === "string" ? meta.columnId : "";
      const name = columns?.find((column) => column.id === columnId)?.name;
      return name ? `Task moved to ${name}` : "Task moved";
    }
    case "assigned":
      return "Assignees updated";
    case "commented":
      return "New comment";
    case "comment_edited":
      return "Comment edited";
    case "comment_deleted":
      return "Comment deleted";
    case "attachment":
      return typeof meta.filename === "string" ? `Attached ${meta.filename}` : "File attached";
    case "attachment_deleted":
      return typeof meta.filename === "string" ? `Removed ${meta.filename}` : "Attachment removed";
    case "checklist":
      return "Checklist added";
    case "archived":
      return "Task deleted";
    default:
      return item.action.replace(/_/g, " ");
  }
}
