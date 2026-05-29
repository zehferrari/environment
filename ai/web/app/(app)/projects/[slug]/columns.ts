export const COLUMNS = [
  { id: "Backlog", label: "Backlog", description: "planning and agent opinions" },
  { id: "To Do", label: "To Do", description: "approved to execute" },
  { id: "In Progress", label: "In Progress", description: "active implementation" },
  { id: "Review", label: "Review", description: "completed work review" },
  { id: "Done", label: "Done", description: "accepted and closed" },
] as const;

export type ColumnId = (typeof COLUMNS)[number]["id"];
export const COLUMN_IDS: readonly string[] = COLUMNS.map((c) => c.id);
