// Human-readable formatter for ActivityLog rows (HOMELAB-44 Stage 2).
// Pure function: takes a stored row and returns a short label suitable
// for rendering in the project board feed. Unknown kinds fall through
// to a generic "<actor> · <kind>" label so new event types remain
// visible before they get a dedicated formatter.

export type ActivityKind =
  | "task.move"
  | "task.ack.auto"
  | "task.comment"
  | "task.comment.delete"
  | "task.assign"
  | "task.acting_manager"
  | "task.create"
  | "task.update"
  | "task.epic"
  | "task.attachment.add"
  | "task.attachment.delete"
  | "epic.create"
  | "epic.update"
  | "epic.assign"
  | "epic.acting_manager"
  | "epic.status"
  | "epic.attachment.add"
  | "epic.attachment.delete"
  | "task.delete"
  | "task.restore"
  | "epic.delete"
  | "epic.restore"
  | "bin.purge"
  | "task.chat.send"
  | "epic.chat.send"
  | "agent.direct_chat.send"
  | "agent.direct_chat.wake"
  | "agent.direct_chat.wake_failed"
  | "agent.direct_chat.reply"
  | "agent.direct_chat.archive"
  | "agent.direct_chat.archive_delete"
  | "task.chat.delete"
  | "epic.chat.delete"
  | "agent.direct_chat.delete"
  | "task.description.agent_write"
  | "epic.description.agent_write"
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

// task.create payload: title is the new task's title at creation time
// (so the feed reads correctly even if the row is later renamed or
// deleted, in which case row.taskTitle would go null). parentTaskId +
// parentTitle are set only when the row represents sub-task creation;
// top-level creates may omit them so a later slice can backfill
// top-level createTask without changing this contract.
interface TaskCreatePayload {
  title?: string;
  parentTaskId?: string | null;
  parentTitle?: string | null;
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
    case "task.comment.delete":
      return `${actor(row.actorName)} deleted a comment on ${task(row.taskTitle)}`;
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
    case "task.create": {
      const p = parsePayload<TaskCreatePayload>(row.payload);
      // Prefer the payload's frozen title so the label still reads
      // correctly if the task row was later renamed; fall back to the
      // current task title from the join when payload is missing.
      const title = p?.title ?? row.taskTitle;
      if (p?.parentTitle) {
        return `${actor(row.actorName)} created sub-task ${task(title)} under ${p.parentTitle}`;
      }
      return `${actor(row.actorName)} created task ${task(title)}`;
    }
    case "task.update":
      return `${actor(row.actorName)} updated ${task(row.taskTitle)}`;
    case "task.epic": {
      const p = parsePayload<{ from?: string | null; to?: string | null }>(row.payload);
      if (p) {
        if (!p.from && p.to) return `${actor(row.actorName)} linked ${task(row.taskTitle)} to epic ${p.to}`;
        if (p.from && !p.to) return `${actor(row.actorName)} removed ${task(row.taskTitle)} from epic ${p.from}`;
        if (p.from && p.to) return `${actor(row.actorName)} moved ${task(row.taskTitle)} from epic ${p.from} to ${p.to}`;
      }
      return `${actor(row.actorName)} changed epic on ${task(row.taskTitle)}`;
    }
    case "task.attachment.add": {
      const p = parsePayload<{ filename?: string }>(row.payload);
      return `${actor(row.actorName)} attached ${p?.filename ?? "a file"} to ${task(row.taskTitle)}`;
    }
    case "task.attachment.delete": {
      const p = parsePayload<{ filename?: string }>(row.payload);
      return `${actor(row.actorName)} removed ${p?.filename ?? "an attachment"} from ${task(row.taskTitle)}`;
    }
    case "epic.create": {
      const p = parsePayload<{ title?: string }>(row.payload);
      return `${actor(row.actorName)} created epic ${p?.title ?? ""}`.trim();
    }
    case "epic.update":
      return `${actor(row.actorName)} updated an epic`;
    case "epic.assign": {
      const p = parsePayload<{ from?: string | null; to?: string | null }>(row.payload);
      if (p?.to && !p?.from) return `${actor(row.actorName)} assigned an epic to @${p.to}`;
      if (p?.from && !p?.to) return `${actor(row.actorName)} unassigned an epic (was @${p.from})`;
      if (p?.from && p?.to) return `${actor(row.actorName)} reassigned an epic from @${p.from} to @${p.to}`;
      return `${actor(row.actorName)} updated epic assignment`;
    }
    case "epic.acting_manager": {
      const p = parsePayload<{ from?: string | null; to?: string | null }>(row.payload);
      if (p?.to && !p?.from) return `${actor(row.actorName)} set @${p.to} as epic acting manager`;
      if (p?.from && !p?.to) return `${actor(row.actorName)} cleared epic acting manager (was @${p.from})`;
      if (p?.from && p?.to) return `${actor(row.actorName)} changed epic acting manager from @${p.from} to @${p.to}`;
      return `${actor(row.actorName)} updated epic acting manager`;
    }
    case "epic.status": {
      const p = parsePayload<{ from?: string; to?: string }>(row.payload);
      if (p?.from && p?.to) return `${actor(row.actorName)} moved an epic from ${p.from} to ${p.to}`;
      return `${actor(row.actorName)} updated epic status`;
    }
    case "epic.attachment.add": {
      const p = parsePayload<{ filename?: string }>(row.payload);
      return `${actor(row.actorName)} attached ${p?.filename ?? "a file"} to an epic`;
    }
    case "epic.attachment.delete": {
      const p = parsePayload<{ filename?: string }>(row.payload);
      return `${actor(row.actorName)} removed ${p?.filename ?? "an attachment"} from an epic`;
    }
    case "task.delete": {
      const p = parsePayload<{ cascadedSubtaskIds?: string[] }>(row.payload);
      const n = p?.cascadedSubtaskIds?.length ?? 0;
      return n > 0
        ? `${actor(row.actorName)} moved ${task(row.taskTitle)} to the bin (${n} sub-task${n === 1 ? "" : "s"} too)`
        : `${actor(row.actorName)} moved ${task(row.taskTitle)} to the bin`;
    }
    case "task.restore": {
      const p = parsePayload<{ restoredChildren?: string[]; withChildren?: boolean }>(row.payload);
      const n = p?.restoredChildren?.length ?? 0;
      return p?.withChildren && n > 0
        ? `${actor(row.actorName)} restored ${task(row.taskTitle)} + ${n} sub-task${n === 1 ? "" : "s"}`
        : `${actor(row.actorName)} restored ${task(row.taskTitle)}`;
    }
    case "epic.delete": {
      const p = parsePayload<{ cascadedTaskIds?: string[] }>(row.payload);
      const n = p?.cascadedTaskIds?.length ?? 0;
      return n > 0
        ? `${actor(row.actorName)} moved an epic to the bin (${n} task${n === 1 ? "" : "s"} too)`
        : `${actor(row.actorName)} moved an epic to the bin`;
    }
    case "epic.restore": {
      const p = parsePayload<{ restoredTasks?: string[]; withChildren?: boolean }>(row.payload);
      const n = p?.restoredTasks?.length ?? 0;
      return p?.withChildren && n > 0
        ? `${actor(row.actorName)} restored an epic + ${n} task${n === 1 ? "" : "s"}`
        : `${actor(row.actorName)} restored an epic`;
    }
    case "bin.purge": {
      const p = parsePayload<{
        purgedEpics?: number;
        purgedTasks?: number;
        removedBlobs?: number;
      }>(row.payload);
      const e = p?.purgedEpics ?? 0;
      const t = p?.purgedTasks ?? 0;
      const b = p?.removedBlobs ?? 0;
      return `Bin purge — ${e} epic${e === 1 ? "" : "s"}, ${t} task${t === 1 ? "" : "s"}, ${b} blob${b === 1 ? "" : "s"}`;
    }
    case "task.chat.send":
    case "epic.chat.send": {
      const p = parsePayload<{ agentSlug?: string; allowDescriptionEdit?: boolean }>(row.payload);
      const target = row.kind === "task.chat.send" ? task(row.taskTitle) : "an epic";
      const tag = p?.allowDescriptionEdit ? " (edit grant)" : "";
      return `${actor(row.actorName)} messaged @${p?.agentSlug ?? "?"} on ${target}${tag}`;
    }
    case "agent.direct_chat.send": {
      const p = parsePayload<{ agentSlug?: string }>(row.payload);
      return `${actor(row.actorName)} messaged @${p?.agentSlug ?? "?"}`;
    }
    case "agent.direct_chat.wake": {
      const p = parsePayload<{ agentSlug?: string }>(row.payload);
      return `PM woke @${p?.agentSlug ?? "?"} for direct chat`;
    }
    case "agent.direct_chat.wake_failed": {
      const p = parsePayload<{ agentSlug?: string; error?: string }>(row.payload);
      return `PM could not wake @${p?.agentSlug ?? "?"}: ${p?.error ?? "unknown error"}`;
    }
    case "agent.direct_chat.reply": {
      const p = parsePayload<{ agentSlug?: string }>(row.payload);
      return `@${p?.agentSlug ?? "agent"} replied in direct chat`;
    }
    case "agent.direct_chat.archive": {
      const p = parsePayload<{ agentSlug?: string; messageCount?: number }>(row.payload);
      const count = p?.messageCount ?? 0;
      return `${actor(row.actorName)} archived direct chat with @${p?.agentSlug ?? "?"} (${count} message${count === 1 ? "" : "s"})`;
    }
    case "agent.direct_chat.archive_delete": {
      const p = parsePayload<{ agentSlug?: string }>(row.payload);
      return `${actor(row.actorName)} removed an archived direct chat with @${p?.agentSlug ?? "?"}`;
    }
    case "task.chat.delete":
    case "epic.chat.delete": {
      const p = parsePayload<{ agentSlug?: string }>(row.payload);
      const target = row.kind === "task.chat.delete" ? task(row.taskTitle) : "an epic";
      return `${actor(row.actorName)} deleted a chat message to @${p?.agentSlug ?? "?"} on ${target}`;
    }
    case "agent.direct_chat.delete": {
      const p = parsePayload<{ agentSlug?: string }>(row.payload);
      return `${actor(row.actorName)} deleted a chat message to @${p?.agentSlug ?? "?"}`;
    }
    case "task.description.agent_write": {
      const p = parsePayload<{ agentSlug?: string; length?: number }>(row.payload);
      return `@${p?.agentSlug ?? "agent"} wrote the description for ${task(row.taskTitle)} (${p?.length ?? 0} chars)`;
    }
    case "epic.description.agent_write": {
      const p = parsePayload<{ agentSlug?: string; length?: number }>(row.payload);
      return `@${p?.agentSlug ?? "agent"} wrote an epic description (${p?.length ?? 0} chars)`;
    }
    default:
      return `${actor(row.actorName)} · ${row.kind}`;
  }
}
