// Human-readable formatter for ActivityLog rows (HOMELAB-44 Stage 2).
// Pure function: takes a stored row and returns a short label suitable
// for rendering in the project board feed. Unknown kinds fall through
// to a generic "<actor> · <kind>" label so new event types remain
// visible before they get a dedicated formatter.

export type ActivityKind =
  | "task.move"
  | "task.ack.auto"
  | "task.comment"
  | "task.comment.silent"
  | "task.comment.delete"
  | "task.comment.restore"
  | "epic.comment.delete"
  | "epic.comment.restore"
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
  | "task.archive"
  | "task.unarchive"
  | "task.auto_archive"
  | "task.auto_archive.summary"
  | "epic.delete"
  | "epic.restore"
  | "epic.archive"
  | "epic.unarchive"
  | "bin.purge"
  | "task.chat.send"
  | "task.chat.silent"
  | "epic.chat.send"
  | "epic.chat.silent"
  | "task.chat.archive"
  | "epic.chat.archive"
  | "task.chat.delete_to_bin"
  | "epic.chat.delete_to_bin"
  | "agent.direct_chat.send"
  | "agent.direct_chat.wake"
  | "agent.direct_chat.wake_failed"
  | "agent.direct_chat.reply"
  | "agent.direct_chat.silent"
  | "agent.direct_chat.archive"
  | "agent.direct_chat.delete_to_bin"
  | "agent.direct_chat.archive_delete"
  | "agent.service.toggle"
  | "agent.service.toggle_failed"
  | "agent.service.restart"
  | "agent.service.restart_failed"
  | "agent.registry.toggle"
  | "agent.registry.toggle_failed"
  | "agent.registry.add"
  | "agent.registry.edit"
  | "agent.registry.remove"
  | "agent.integration.credentials"
  | "agent.integration.credentials_failed"
  | "agent.model.update"
  | "agent.profile.update"
  | "agent.restart.requested"
  | "agent.restart.failed"
  | "task.chat.delete"
  | "epic.chat.delete"
  | "agent.direct_chat.delete"
  | "task.chat.restore"
  | "epic.chat.restore"
  | "agent.direct_chat.restore"
  | "task.description.agent_write"
  | "epic.description.agent_write"
  | "workitem.proposal.propose"
  | "workitem.proposal.apply"
  | "workitem.proposal.reject"
  | "system.settings"
  | "project.create"
  | "project.archive"
  | "project.unarchive"
  | "agent.sync"
  | "task.subtask.add"
  | "task.subtask.complete"
  | "task.subtask.delete"
  | "task.subtask.time"
  | "task.chat.reply"
  | "epic.chat.reply"
  | "task.chat.stream_error"
  | "task.action_plan.approve"
  | "task.action_plan.reset"
  | "epic.action_plan.reset"
  | "task.branch"
  | "task.commit_prefix"
  | "task.workflow.notify"
  | "task.workflow.dispatch"
  | "task.workflow.next_assignment_skipped"
  | "task.comment.dispatch"
  | "pm.repo.verify.enqueue"
  | "pm.repo.verify.ok"
  | "pm.repo.verify.fail"
  | "pm.channel.latency_warning"
  | "agent.wake.delivered"
  | "agent.wake.unmatched"
  | "pm.self_assignment_guard"
  | string;

export interface ActivityRow {
  kind: ActivityKind;
  payload: string | null;
  actorName: string | null;
  taskTitle: string | null;
  targetAgent?: string | null;
  targetFile?: string | null;
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

function trunc(text: string, max = 64): string {
  const clean = text.trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function actor(name: string | null): string {
  return name ?? "Someone";
}

function task(title: string | null): string {
  return title ?? "a task";
}

function targetAgent(row: ActivityRow): string {
  return row.targetAgent ? `@${row.targetAgent}` : "an agent";
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
    case "task.comment.silent":
      return `${targetAgent(row)} had no task-comment update to add`;
    case "task.comment.delete":
      return `${actor(row.actorName)} deleted a comment on ${task(row.taskTitle)}`;
    case "task.comment.restore":
      return `${actor(row.actorName)} restored a comment on ${task(row.taskTitle)}`;
    case "epic.comment.delete":
      return `${actor(row.actorName)} deleted a comment on an epic`;
    case "epic.comment.restore":
      return `${actor(row.actorName)} restored a comment on an epic`;
    case "task.chat.restore":
      return `${actor(row.actorName)} restored a discussion message on ${task(row.taskTitle)}`;
    case "epic.chat.restore":
      return `${actor(row.actorName)} restored a discussion message on an epic`;
    case "agent.direct_chat.restore":
      return `${actor(row.actorName)} restored a direct-chat message`;
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
    case "task.archive":
      return `${actor(row.actorName)} archived ${task(row.taskTitle)}`;
    case "task.unarchive":
      return `${actor(row.actorName)} restored ${task(row.taskTitle)} from archive`;
    case "task.auto_archive":
      return `System archived ${task(row.taskTitle)} after the automatic archive window`;
    case "task.auto_archive.summary": {
      const p = parsePayload<{ archivedTasks?: number; projectsChecked?: number }>(row.payload);
      const n = p?.archivedTasks ?? 0;
      return `System automatic archive — ${n} task${n === 1 ? "" : "s"} archived`;
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
    case "epic.archive":
      return `${actor(row.actorName)} archived an epic`;
    case "epic.unarchive":
      return `${actor(row.actorName)} restored an epic from archive`;
    case "project.archive":
      return `${actor(row.actorName)} archived this project`;
    case "project.unarchive":
      return `${actor(row.actorName)} restored this project from archive`;
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
      const p = parsePayload<{ agentSlug?: string }>(row.payload);
      const target = row.kind === "task.chat.send" ? task(row.taskTitle) : "an epic";
      return `${actor(row.actorName)} messaged @${p?.agentSlug ?? "?"} on ${target}`;
    }
    case "task.chat.silent":
      return `${targetAgent(row)} had no task-chat update to add`;
    case "epic.chat.silent":
      return `${targetAgent(row)} had no epic-chat update to add`;
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
    case "agent.direct_chat.silent":
      return `${targetAgent(row)} had no direct-chat update to add`;
    case "agent.direct_chat.archive": {
      const p = parsePayload<{ agentSlug?: string; messageCount?: number }>(row.payload);
      const count = p?.messageCount ?? 0;
      return `${actor(row.actorName)} archived direct chat with @${p?.agentSlug ?? "?"} (${count} message${count === 1 ? "" : "s"})`;
    }
    case "agent.direct_chat.delete_to_bin": {
      const p = parsePayload<{ agentSlug?: string; messageCount?: number }>(row.payload);
      const count = p?.messageCount ?? 0;
      return `${actor(row.actorName)} moved direct chat with @${p?.agentSlug ?? "?"} to the bin (${count} message${count === 1 ? "" : "s"})`;
    }
    case "agent.direct_chat.archive_delete": {
      const p = parsePayload<{ agentSlug?: string }>(row.payload);
      return `${actor(row.actorName)} removed an archived direct chat with @${p?.agentSlug ?? "?"}`;
    }
    case "agent.service.toggle":
    case "agent.service.toggle_failed": {
      const p = parsePayload<{ service?: string; enabled?: boolean; error?: string | null }>(row.payload);
      const verb = p?.enabled ? "started" : "stopped";
      const base = `${actor(row.actorName)} ${verb} ${p?.service ?? "a service"} for ${targetAgent(row)}`;
      return row.kind.endsWith("_failed") ? `${base} failed${p?.error ? `: ${p.error}` : ""}` : base;
    }
    case "agent.service.restart":
    case "agent.service.restart_failed": {
      const p = parsePayload<{ service?: string; error?: string | null }>(row.payload);
      const base = `${actor(row.actorName)} restarted ${p?.service ?? "a service"} for ${targetAgent(row)}`;
      return row.kind.endsWith("_failed") ? `${base} failed${p?.error ? `: ${p.error}` : ""}` : base;
    }
    case "agent.registry.toggle":
    case "agent.registry.toggle_failed": {
      const p = parsePayload<{ kind?: string; key?: string; value?: boolean; error?: string | null }>(row.payload);
      const verb = p?.value ? "enabled" : "disabled";
      const base = `${actor(row.actorName)} ${verb} ${p?.kind ?? "setting"}.${p?.key ?? "unknown"} for ${targetAgent(row)}`;
      return row.kind.endsWith("_failed") ? `${base} failed${p?.error ? `: ${p.error}` : ""}` : base;
    }
    case "agent.registry.add": {
      const p = parsePayload<{ uid?: number; role?: string }>(row.payload);
      const suffix = p?.role ? ` (${p.role}${p?.uid ? `, uid ${p.uid}` : ""})` : "";
      return `${actor(row.actorName)} created agent ${targetAgent(row)}${suffix}`;
    }
    case "agent.registry.edit": {
      const p = parsePayload<{ roleChanged?: boolean; role?: string }>(row.payload);
      const suffix = p?.roleChanged && p?.role ? ` → ${p.role}` : "";
      return `${actor(row.actorName)} edited agent ${targetAgent(row)}${suffix}`;
    }
    case "agent.registry.remove":
      return `${actor(row.actorName)} removed agent ${targetAgent(row)}`;
    case "agent.integration.credentials":
    case "agent.integration.credentials_failed": {
      const p = parsePayload<{ integration?: string; fields?: string[]; error?: string | null }>(row.payload);
      const fields = p?.fields?.length ? ` (${p.fields.join(", ")})` : "";
      const base = `${actor(row.actorName)} updated ${p?.integration ?? "integration"} credentials for ${targetAgent(row)}${fields}`;
      return row.kind.endsWith("_failed") ? `${base} failed${p?.error ? `: ${p.error}` : ""}` : base;
    }
    case "agent.model.update": {
      const p = parsePayload<{ before?: { active?: string | null }; after?: { active?: string | null } }>(row.payload);
      const from = p?.before?.active ?? "unset";
      const to = p?.after?.active ?? "unset";
      return `${actor(row.actorName)} changed ${targetAgent(row)} model from ${from} to ${to}`;
    }
    case "agent.profile.update":
      return `${actor(row.actorName)} updated ${targetAgent(row)} profile${row.targetFile ? ` (${row.targetFile})` : ""}`;
    case "agent.profile.image_update":
      return `${actor(row.actorName)} uploaded ${targetAgent(row)} image${row.targetFile ? ` (${row.targetFile})` : ""}`;
    case "agent.profile.image_remove":
      return `${actor(row.actorName)} removed ${targetAgent(row)} image${row.targetFile ? ` (${row.targetFile})` : ""}`;
    case "agent.profile.image_theme_update": {
      const p = parsePayload<{ theme?: string }>(row.payload);
      return `${actor(row.actorName)} changed ${targetAgent(row)} image theme${p?.theme ? ` to ${p.theme}` : ""}`;
    }
    case "agent.profile.image_request": {
      const p = parsePayload<{ generatorAgent?: string; theme?: string }>(row.payload);
      return `${actor(row.actorName)} requested profile images for ${targetAgent(row)}${p?.generatorAgent ? ` from @${p.generatorAgent}` : ""}${p?.theme ? ` (${p.theme})` : ""}`;
    }
    case "agent.profile.image_request_failed": {
      const p = parsePayload<{ reason?: string; error?: string; theme?: string }>(row.payload);
      return `${actor(row.actorName)} profile image request for ${targetAgent(row)} failed${p?.reason || p?.error ? `: ${p.reason ?? p.error}` : ""}`;
    }
    case "agent.restart.requested":
    case "agent.restart.failed": {
      const p = parsePayload<{ reason?: string; services?: Array<{ service?: string; ok?: boolean }> }>(row.payload);
      const serviceCount = p?.services?.length ?? 0;
      const base = `PM requested restart for ${targetAgent(row)}${p?.reason ? ` (${p.reason})` : ""}`;
      const suffix = serviceCount ? ` across ${serviceCount} service${serviceCount === 1 ? "" : "s"}` : "";
      return row.kind.endsWith(".failed") ? `${base} failed${suffix}` : `${base}${suffix}`;
    }
    case "task.chat.archive":
    case "epic.chat.archive": {
      const p = parsePayload<{ messageCount?: number }>(row.payload);
      const count = p?.messageCount ?? 0;
      const target = row.kind === "task.chat.archive" ? task(row.taskTitle) : "an epic";
      return `${actor(row.actorName)} archived the chat room on ${target} (${count} message${count === 1 ? "" : "s"})`;
    }
    case "task.chat.delete_to_bin":
    case "epic.chat.delete_to_bin": {
      const p = parsePayload<{ messageCount?: number }>(row.payload);
      const count = p?.messageCount ?? 0;
      const target = row.kind === "task.chat.delete_to_bin" ? task(row.taskTitle) : "an epic";
      return `${actor(row.actorName)} moved the chat room on ${target} to the bin (${count} message${count === 1 ? "" : "s"})`;
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
    case "workitem.proposal.propose": {
      const p = parsePayload<{ agentSlug?: string; opCount?: number }>(row.payload);
      const n = p?.opCount ?? 0;
      return `@${p?.agentSlug ?? "agent"} proposed ${n} work-item change${n === 1 ? "" : "s"} for review`;
    }
    case "workitem.proposal.apply": {
      const p = parsePayload<{ agentSlug?: string; opCount?: number }>(row.payload);
      const n = p?.opCount ?? 0;
      return `${actor(row.actorName)} applied ${n} proposed change${n === 1 ? "" : "s"} from @${p?.agentSlug ?? "agent"}`;
    }
    case "workitem.proposal.reject": {
      const p = parsePayload<{ agentSlug?: string }>(row.payload);
      return `${actor(row.actorName)} rejected a work-item proposal from @${p?.agentSlug ?? "agent"}`;
    }
    case "task.subtask.add":
    case "task.subtask.complete":
    case "task.subtask.delete": {
      const p = parsePayload<{ text?: string }>(row.payload);
      const verb =
        row.kind === "task.subtask.add" ? "added" : row.kind === "task.subtask.complete" ? "completed" : "removed";
      const item = p?.text ? ` “${trunc(p.text)}”` : "";
      return `${actor(row.actorName)} ${verb} checklist item${item} on ${task(row.taskTitle)}`;
    }
    case "task.subtask.time": {
      const p = parsePayload<{ text?: string; minutesSpent?: number }>(row.payload);
      const minutes = p?.minutesSpent != null ? `${p.minutesSpent}m` : "time";
      const item = p?.text ? ` “${trunc(p.text)}”` : "";
      return `${actor(row.actorName)} logged ${minutes} on checklist item${item}`;
    }
    case "task.chat.reply":
    case "epic.chat.reply": {
      const p = parsePayload<{ agentSlug?: string }>(row.payload);
      const target = row.kind === "task.chat.reply" ? task(row.taskTitle) : "an epic";
      return `@${p?.agentSlug ?? "agent"} replied in the chat on ${target}`;
    }
    case "task.chat.stream_error": {
      const p = parsePayload<{ target?: { agentSlug?: string }; error?: string }>(row.payload);
      const slug = p?.target?.agentSlug;
      return `Chat stream ${slug ? `to @${slug} ` : ""}failed on ${task(row.taskTitle)}${p?.error ? `: ${trunc(p.error, 80)}` : ""}`;
    }
    case "task.action_plan.approve":
      return `${actor(row.actorName)} approved the action plan on ${task(row.taskTitle)}`;
    case "task.action_plan.reset":
    case "epic.action_plan.reset": {
      const p = parsePayload<{ reason?: string }>(row.payload);
      const target = row.kind === "task.action_plan.reset" ? task(row.taskTitle) : "an epic";
      return `Action plan reset on ${target}${p?.reason ? ` (${p.reason})` : ""}`;
    }
    case "task.branch": {
      const p = parsePayload<{ from?: string | null; to?: string | null }>(row.payload);
      if (p?.to && !p?.from) return `${actor(row.actorName)} set branch ${p.to} on ${task(row.taskTitle)}`;
      if (p?.from && !p?.to) return `${actor(row.actorName)} cleared branch on ${task(row.taskTitle)} (was ${p.from})`;
      if (p?.from && p?.to) return `${actor(row.actorName)} changed branch on ${task(row.taskTitle)} to ${p.to}`;
      return `${actor(row.actorName)} updated branch on ${task(row.taskTitle)}`;
    }
    case "task.commit_prefix": {
      const p = parsePayload<{ from?: string | null; to?: string | null }>(row.payload);
      return p?.to
        ? `${actor(row.actorName)} set commit prefix ${p.to} on ${task(row.taskTitle)}`
        : `${actor(row.actorName)} updated commit prefix on ${task(row.taskTitle)}`;
    }
    case "task.workflow.notify": {
      const p = parsePayload<{ agentSlug?: string; reason?: string }>(row.payload);
      return `PM workflow notified @${p?.agentSlug ?? "?"}${p?.reason ? ` (${p.reason})` : ""}`;
    }
    case "task.workflow.dispatch": {
      const p = parsePayload<{ agentSlug?: string; reason?: string; error?: string | null }>(row.payload);
      const base = `PM dispatched a workflow turn to @${p?.agentSlug ?? "?"}${p?.reason ? ` (${p.reason})` : ""}`;
      return p?.error ? `${base} — error: ${trunc(p.error, 80)}` : base;
    }
    case "task.workflow.next_assignment_skipped": {
      const p = parsePayload<{ reason?: string }>(row.payload);
      return `Workflow skipped the next assignment${p?.reason ? ` (${p.reason})` : ""}`;
    }
    case "task.comment.dispatch": {
      const p = parsePayload<{ agentSlug?: string; reason?: string[]; error?: string | null }>(row.payload);
      const reasons = p?.reason?.length ? ` (${p.reason.join(", ")})` : "";
      const base = `PM dispatched a comment to @${p?.agentSlug ?? "?"}${reasons}`;
      return p?.error ? `${base} — error: ${trunc(p.error, 80)}` : base;
    }
    case "pm.repo.verify.enqueue":
    case "pm.repo.verify.ok":
    case "pm.repo.verify.fail": {
      const p = parsePayload<{ branchName?: string }>(row.payload);
      const verb = row.kind.endsWith(".enqueue") ? "queued" : row.kind.endsWith(".ok") ? "passed" : "failed";
      return `Repo verify ${verb}${p?.branchName ? ` for ${p.branchName}` : ""}`;
    }
    case "pm.channel.latency_warning": {
      const p = parsePayload<{ agentSlug?: string; kind?: string }>(row.payload);
      return `PM channel latency warning — @${p?.agentSlug ?? "?"}${p?.kind ? ` (${p.kind})` : ""}`;
    }
    case "agent.wake.delivered":
    case "agent.wake.unmatched": {
      const p = parsePayload<{ kind?: string }>(row.payload);
      const event = p?.kind ? `${p.kind} wake event` : "Wake event";
      return row.kind.endsWith(".delivered") ? `${event} delivered` : `${event} matched no agent`;
    }
    case "pm.self_assignment_guard": {
      const p = parsePayload<{ repairs?: unknown[] }>(row.payload);
      const n = p?.repairs?.length ?? 0;
      return `Self-assignment guard repaired ${n} assignment${n === 1 ? "" : "s"}`;
    }
    case "system.settings":
      return `${actor(row.actorName)} updated system settings`;
    default:
      return `${actor(row.actorName)} · ${row.kind}`;
  }
}
