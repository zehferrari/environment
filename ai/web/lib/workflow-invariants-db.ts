// ENV-116 — read-only live-DB adapter for the workflow invariant registry.
//
// Loads a WorkflowInvariantSnapshot out of the PM database and evaluates the
// pure predicates in lib/workflow-invariants.ts against it. STRICTLY READ-ONLY:
// every query here is a findMany/findFirst/count. Nothing in this module — or
// in the monitor script that wraps it — may write, and the db test asserts that.
//
// ENV-118 made settledByAction and disposition real columns on PmChannelRun,
// so two of the three derived fields are now READ rather than guessed:
//
//   settledByAction  — read from the column, which is written only when a
//                      workflow action was the thing that settled the run.
//                      Rows written before the ENV-118 migration have no
//                      disposition, and only those fall back to the original
//                      ActivityLog derivation (task.move, blocker raise/clear,
//                      action-plan approval) so historical violations stay
//                      visible. add_subtask/complete_subtask/remove_subtask had
//                      no durable trace at all under the old scheme; they are
//                      exact now.
//   disposition      — read from the column. Every terminal write records one.
//   finalResponseText — still reconstructed from the reply/silent ActivityLog
//                      row that PM writes per turn, then the referenced chat
//                      message or comment body. Epic item 3 owns making the
//                      response itself durable.

import { db } from "@/lib/db";
import {
  evaluateWorkflowInvariants,
  type BlockerRecord,
  type InvariantViolation,
  type RunRecord,
  type TaskRecord,
  type WorkflowInvariantSnapshot,
} from "@/lib/workflow-invariants";

/** ActivityLog kinds from which a settling workflow action can be recovered. */
const ACTION_BEARING_ACTIVITY_KINDS = [
  "task.move",
  "task.blocker",
  "task.extra_work.blocker",
  "task.blocker.cleared",
  "task.action_plan.approve",
] as const;

const BLOCKER_ACTIVITY_KINDS = [
  "task.blocker",
  "task.extra_work.blocker",
  "task.blocker.cleared",
] as const;

/** ActivityLog kinds that record a turn's durable reply (or explicit silence). */
const REPLY_ACTIVITY_KINDS = [
  "task.chat.reply",
  "task.comment",
  "epic.chat.reply",
  "agent.direct_chat.reply",
] as const;

const SILENT_ACTIVITY_KINDS = [
  "task.chat.silent",
  "task.comment.silent",
  "epic.chat.silent",
  "agent.direct_chat.silent",
] as const;

/** Settling actions cannot be attributed to a run beyond this clock skew. */
const SETTLE_ATTRIBUTION_SLACK_MS = 5_000;

export interface SnapshotOptions {
  /** Restrict to one project. Omit to scan every project. */
  projectId?: string;
  /** Only consider runs created within this window. Default 14 days. */
  sinceMs?: number;
  /** Evaluation instant. Default Date.now(). */
  now?: number;
  /** Safety cap on rows pulled per table. Default 5000. */
  take?: number;
}

function ms(value: Date | null | undefined): number | null {
  return value ? value.getTime() : null;
}

function parsePayload(payload: string | null): Record<string, unknown> | null {
  if (!payload) return null;
  try {
    const parsed: unknown = JSON.parse(payload);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function stringField(
  record: Record<string, unknown> | null,
  key: string,
): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function actionFromActivity(kind: string, payload: string | null): string | null {
  const parsed = parsePayload(payload);
  switch (kind) {
    case "task.move":
      return stringField(parsed, "action");
    case "task.blocker":
      return "flag_blocker";
    case "task.extra_work.blocker":
      return "flag_extra_work_blocker";
    case "task.blocker.cleared":
      return "clear_blocker";
    case "task.action_plan.approve":
      return "approve_plan";
    default:
      return stringField(parsed, "action");
  }
}

interface ActivityRow {
  id: string;
  kind: string;
  taskId: string | null;
  userId: string | null;
  targetAgent: string | null;
  payload: string | null;
  createdAt: Date;
}

/**
 * Load a snapshot of live PM state. Read-only.
 */
export async function loadWorkflowInvariantSnapshot(
  options: SnapshotOptions = {},
): Promise<WorkflowInvariantSnapshot> {
  const now = options.now ?? Date.now();
  const sinceMs = options.sinceMs ?? 14 * 24 * 60 * 60 * 1000;
  const since = new Date(now - sinceMs);
  const take = options.take ?? 5_000;

  // agentSlug → seeded User id, so activity rows can be attributed to a run.
  const agents = await db.agent.findMany({
    select: { slug: true, user: { select: { id: true } } },
  });
  const userIdBySlug = new Map<string, string>();
  const slugByUserId = new Map<string, string>();
  for (const agent of agents) {
    if (!agent.user) continue;
    userIdBySlug.set(agent.slug, agent.user.id);
    slugByUserId.set(agent.user.id, agent.slug);
  }

  const runRows = await db.pmChannelRun.findMany({
    where: {
      createdAt: { gte: since },
      ...(options.projectId ? { projectId: options.projectId } : {}),
    },
    orderBy: { createdAt: "asc" },
    take,
    select: {
      id: true,
      agentSlug: true,
      taskId: true,
      epicId: true,
      messageId: true,
      status: true,
      createdAt: true,
      acceptedAt: true,
      streamingAt: true,
      completedAt: true,
      failedAt: true,
      lastEventAt: true,
      disposition: true,
      settledByAction: true,
    },
  });

  const taskIds = Array.from(
    new Set(runRows.map((run) => run.taskId).filter((id): id is string => Boolean(id))),
  );

  const taskRows = await db.task.findMany({
    where: {
      deletedAt: null,
      ...(options.projectId ? { projectId: options.projectId } : {}),
      ...(taskIds.length > 0
        ? { OR: [{ id: { in: taskIds } }, { status: "In Progress" }] }
        : { status: "In Progress" }),
    },
    take,
    select: {
      id: true,
      status: true,
      assigneeId: true,
      reporterId: true,
      approvedOn: true,
      checklist: {
        where: { kind: "implementation" },
        select: { id: true },
      },
    },
  });

  const allTaskIds = Array.from(
    new Set([...taskIds, ...taskRows.map((task) => task.id)]),
  );

  const activityRows: ActivityRow[] = allTaskIds.length
    ? await db.activityLog.findMany({
        where: {
          taskId: { in: allTaskIds },
          kind: {
            in: [
              ...ACTION_BEARING_ACTIVITY_KINDS,
              ...REPLY_ACTIVITY_KINDS,
              ...SILENT_ACTIVITY_KINDS,
            ],
          },
        },
        orderBy: { createdAt: "asc" },
        take,
        select: {
          id: true,
          kind: true,
          taskId: true,
          userId: true,
          targetAgent: true,
          payload: true,
          createdAt: true,
        },
      })
    : [];

  // ---- final response text, per (agentSlug, inReplyToMessageId) ----
  const replyKinds = new Set<string>(REPLY_ACTIVITY_KINDS);
  const silentKinds = new Set<string>(SILENT_ACTIVITY_KINDS);
  const chatMessageIds = new Set<string>();
  const commentIds = new Set<string>();
  type ReplyRef = { kind: "chat" | "comment" | "silent"; id: string | null };
  const replyRefs = new Map<string, ReplyRef>();

  for (const row of activityRows) {
    const isReply = replyKinds.has(row.kind);
    const isSilent = silentKinds.has(row.kind);
    if (!isReply && !isSilent) continue;
    const parsed = parsePayload(row.payload);
    const inReplyTo = stringField(parsed, "inReplyToMessageId");
    if (!inReplyTo || !row.targetAgent) continue;
    const key = `${row.targetAgent}|${inReplyTo}`;
    if (isSilent) {
      replyRefs.set(key, { kind: "silent", id: null });
      continue;
    }
    const commentId = stringField(parsed, "commentId");
    const messageId = stringField(parsed, "messageId");
    if (commentId) {
      commentIds.add(commentId);
      replyRefs.set(key, { kind: "comment", id: commentId });
    } else if (messageId) {
      chatMessageIds.add(messageId);
      replyRefs.set(key, { kind: "chat", id: messageId });
    }
  }

  const chatBodies = new Map<string, string>();
  if (chatMessageIds.size > 0) {
    const rows = await db.agentChatMessage.findMany({
      where: { id: { in: Array.from(chatMessageIds) } },
      select: { id: true, body: true },
    });
    for (const row of rows) chatBodies.set(row.id, row.body);
  }

  const commentBodies = new Map<string, string>();
  if (commentIds.size > 0) {
    const rows = await db.comment.findMany({
      where: { id: { in: Array.from(commentIds) } },
      select: { id: true, body: true },
    });
    for (const row of rows) commentBodies.set(row.id, row.body);
  }

  function finalResponseFor(agentSlug: string, messageId: string): string | null {
    const ref = replyRefs.get(`${agentSlug}|${messageId}`);
    if (!ref) return null;
    if (ref.kind === "silent") return "";
    if (!ref.id) return null;
    return (ref.kind === "comment" ? commentBodies : chatBodies).get(ref.id) ?? null;
  }

  // ---- settling action attribution ----
  const actionBearing = new Set<string>(ACTION_BEARING_ACTIVITY_KINDS);
  const actionRows = activityRows.filter((row) => actionBearing.has(row.kind));

  function settledActionFor(run: (typeof runRows)[number]): string | null {
    const settledAt = ms(run.completedAt) ?? ms(run.failedAt);
    if (settledAt == null || !run.taskId) return null;
    const actorUserId = userIdBySlug.get(run.agentSlug);
    if (!actorUserId) return null;
    const from = run.createdAt.getTime();
    const to = settledAt + SETTLE_ATTRIBUTION_SLACK_MS;
    let best: { at: number; action: string } | null = null;
    for (const row of actionRows) {
      if (row.taskId !== run.taskId) continue;
      if (row.userId !== actorUserId) continue;
      const at = row.createdAt.getTime();
      if (at < from || at > to) continue;
      const action = actionFromActivity(row.kind, row.payload);
      if (!action) continue;
      if (!best || at >= best.at) best = { at, action };
    }
    return best?.action ?? null;
  }

  const runs: RunRecord[] = runRows.map((run) => ({
    id: run.id,
    agentSlug: run.agentSlug,
    taskId: run.taskId,
    epicId: run.epicId,
    messageId: run.messageId,
    status: run.status,
    createdAt: run.createdAt.getTime(),
    acceptedAt: ms(run.acceptedAt),
    streamingAt: ms(run.streamingAt),
    completedAt: ms(run.completedAt),
    failedAt: ms(run.failedAt),
    lastEventAt: ms(run.lastEventAt),
    // The column is authoritative. Only a pre-ENV-118 row (no disposition
    // recorded by any writer) falls back to the ActivityLog derivation.
    settledByAction: run.disposition == null
      ? settledActionFor(run)
      : run.settledByAction,
    finalResponseText: finalResponseFor(run.agentSlug, run.messageId),
    disposition: run.disposition,
  }));

  const tasks: TaskRecord[] = taskRows.map((task) => ({
    id: task.id,
    status: task.status,
    assigneeSlug: task.assigneeId
      ? (slugByUserId.get(task.assigneeId) ?? task.assigneeId)
      : null,
    approvedOn: ms(task.approvedOn),
    checklistCount: task.checklist.length,
    // PM stores no provenance for checklist items. The only automated producer
    // today is the Markdown scraper in lib/tasks/action-plan-subtasks.ts, so a
    // populated checklist is classified as prose-derived until Epic item 4
    // makes approved-plan steps structured data.
    planStepSource: task.checklist.length > 0 ? "markdown-prose" : "none",
  }));

  // ---- blockers: newest activity row per task decides the active state ----
  const blockerKinds = new Set<string>(BLOCKER_ACTIVITY_KINDS);
  const reporterByTask = new Map<string, string | null>(
    taskRows.map((task) => [task.id, task.reporterId] as const),
  );
  const latestBlockerByTask = new Map<string, ActivityRow>();
  for (const row of activityRows) {
    if (!row.taskId || !blockerKinds.has(row.kind)) continue;
    const current = latestBlockerByTask.get(row.taskId);
    if (!current || row.createdAt.getTime() >= current.createdAt.getTime()) {
      latestBlockerByTask.set(row.taskId, row);
    }
  }

  const blockers: BlockerRecord[] = [];
  for (const [taskId, row] of latestBlockerByTask) {
    if (row.kind === "task.blocker.cleared") continue;
    const parsed = parsePayload(row.payload);
    const rawRequest = parsed?.permissionRequest;
    const request =
      rawRequest && typeof rawRequest === "object"
        ? (rawRequest as Record<string, unknown>)
        : null;
    const scope = stringField(request, "scope");
    const reporterId = reporterByTask.get(taskId) ?? null;
    blockers.push({
      id: row.id,
      taskId,
      kind: row.kind,
      // A permission request implies the reporter is the external actor. A
      // general blocker records no actor at all — Epic item 6's gap.
      externalActor: request && reporterId ? `reporter:${reporterId}` : null,
      requirement: scope,
      clearedAt: null,
    });
  }

  return { now, runs, tasks, blockers };
}

export interface WorkflowInvariantReport {
  now: number;
  counts: { runs: number; tasks: number; blockers: number };
  ok: boolean;
  violations: InvariantViolation[];
  byInvariant: Record<string, InvariantViolation[]>;
}

/**
 * Read-only monitor surface: load a live snapshot and evaluate every invariant.
 * Never writes. Safe to call from the Monitor Agent on a schedule.
 */
export async function checkWorkflowInvariants(
  options: SnapshotOptions = {},
): Promise<WorkflowInvariantReport> {
  const snapshot = await loadWorkflowInvariantSnapshot(options);
  const evaluated = evaluateWorkflowInvariants(snapshot);
  return {
    now: snapshot.now,
    counts: {
      runs: snapshot.runs.length,
      tasks: snapshot.tasks.length,
      blockers: snapshot.blockers.length,
    },
    ok: evaluated.ok,
    violations: evaluated.violations,
    byInvariant: evaluated.byInvariant,
  };
}
