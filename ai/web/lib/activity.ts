// Human-readable formatter for ActivityLog rows (HOMELAB-44 Stage 2).
// Pure function: takes a stored row and returns a short label suitable
// for rendering in the project board feed. Unknown kinds fall through
// to a generic "<actor> · <kind>" label so new event types remain
// visible before they get a dedicated formatter.

export type ActivityKind =
  | "task.move"
  | "task.ack.auto"
  | "task.create"
  | "project.create"
  | "agent.sync"
  | string;

export interface ActivityRow {
  kind: ActivityKind;
  payload: string | null;
  actorName: string | null;
  taskTitle: string | null;
}

interface MovePayload {
  from?: string;
  to?: string;
}

function parsePayload<T>(payload: string | null): T | null {
  if (!payload) return null;
  try {
    return JSON.parse(payload) as T;
  } catch {
    return null;
  }
}

function actor(name: string | null): string {
  return name ?? "Someone";
}

function task(title: string | null): string {
  return title ?? "a task";
}

// Returns a single-line human label describing the activity. Does not
// include timestamps — callers render those separately.
export function describeActivity(row: ActivityRow): string {
  switch (row.kind) {
    case "task.move": {
      const p = parsePayload<MovePayload>(row.payload);
      if (p?.from && p?.to) {
        return `${actor(row.actorName)} moved ${task(row.taskTitle)} from ${p.from} to ${p.to}`;
      }
      return `${actor(row.actorName)} moved ${task(row.taskTitle)}`;
    }
    case "task.ack.auto": {
      const p = parsePayload<MovePayload>(row.payload);
      if (p?.from && p?.to) {
        return `${actor(row.actorName)} acknowledged ${task(row.taskTitle)} — auto ${p.from} → ${p.to}`;
      }
      return `${actor(row.actorName)} acknowledged ${task(row.taskTitle)}`;
    }
    default:
      return `${actor(row.actorName)} · ${row.kind}`;
  }
}
