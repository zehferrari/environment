// Human-readable formatter for ActivityLog rows (HOMELAB-44 Stage 2).
// Pure function: takes a stored row and returns a short label suitable
// for rendering in the project board feed. Unknown kinds fall through
// to a generic "<actor> · <kind>" label so new event types remain
// visible before they get a dedicated formatter.

export type ActivityKind =
  | "task.move"
  | "task.ack.auto"
  | "task.comment"
  | "task.assign"
  | "task.acting_manager"
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

interface CommentPayload {
  mentions?: string[];
}

// task.assign payload uses usernames (never raw user IDs) so the feed
// renders a stable label even if the assignee row is later deleted.
// from/to are null for unassigned / unset.
interface AssignPayload {
  from?: string | null;
  to?: string | null;
}

// task.acting_manager payload follows the same shape and rationale as
// AssignPayload — usernames, not IDs, so the feed survives deletion.
interface ActingManagerPayload {
  from?: string | null;
  to?: string | null;
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
    case "task.comment": {
      const p = parsePayload<CommentPayload>(row.payload);
      if (p?.mentions && p.mentions.length > 0) {
        const list = p.mentions.map((m) => `@${m}`).join(", ");
        return `${actor(row.actorName)} commented on ${task(row.taskTitle)} (mentioned ${list})`;
      }
      return `${actor(row.actorName)} commented on ${task(row.taskTitle)}`;
    }
    case "task.assign": {
      const p = parsePayload<AssignPayload>(row.payload);
      if (p) {
        if (!p.from && p.to) {
          return `${actor(row.actorName)} assigned ${task(row.taskTitle)} to @${p.to}`;
        }
        if (p.from && !p.to) {
          return `${actor(row.actorName)} unassigned ${task(row.taskTitle)} (was @${p.from})`;
        }
        if (p.from && p.to) {
          return `${actor(row.actorName)} reassigned ${task(row.taskTitle)} from @${p.from} to @${p.to}`;
        }
      }
      return `${actor(row.actorName)} updated assignment on ${task(row.taskTitle)}`;
    }
    case "task.acting_manager": {
      const p = parsePayload<ActingManagerPayload>(row.payload);
      if (p) {
        if (!p.from && p.to) {
          return `${actor(row.actorName)} set @${p.to} as acting manager on ${task(row.taskTitle)}`;
        }
        if (p.from && !p.to) {
          return `${actor(row.actorName)} cleared acting manager on ${task(row.taskTitle)} (was @${p.from})`;
        }
        if (p.from && p.to) {
          return `${actor(row.actorName)} changed acting manager on ${task(row.taskTitle)} from @${p.from} to @${p.to}`;
        }
      }
      return `${actor(row.actorName)} updated acting manager on ${task(row.taskTitle)}`;
    }
    default:
      return `${actor(row.actorName)} · ${row.kind}`;
  }
}
