export const COLUMNS = [
  { id: "backlog", label: "Backlog" },
  { id: "todo", label: "To Do" },
  { id: "in_progress", label: "In Progress" },
  { id: "review", label: "Review" },
  { id: "done", label: "Done" },
] as const;

export type ColumnId = (typeof COLUMNS)[number]["id"];
export const COLUMN_IDS: readonly string[] = COLUMNS.map((c) => c.id);
