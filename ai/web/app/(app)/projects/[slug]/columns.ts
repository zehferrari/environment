export const COLUMNS = [
  { id: "Backlog", label: "Backlog" },
  { id: "To Do", label: "To Do" },
  { id: "In Progress", label: "In Progress" },
  { id: "Review", label: "Review" },
  { id: "Done", label: "Done" },
] as const;

export type ColumnId = (typeof COLUMNS)[number]["id"];
export const COLUMN_IDS: readonly string[] = COLUMNS.map((c) => c.id);
