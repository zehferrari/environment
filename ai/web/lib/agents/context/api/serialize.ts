// JSON serializers for the agent-facing PM read API.
//
// These are intentionally data-only — no markdown rendering and no
// manifest preamble. Agents fetch JSON they can parse and quote from
// directly. Large text fields are clipped with explicit markers so the
// live-fetch endpoints obey the same budget discipline as rendered
// native context packets. The output shape is documented in
// ai/web/docs/agent-pm-api.md and is the contract agents code against.
//
// Soft-delete (HOMELAB-41 / item 2) is enforced HERE the same way the
// rendered-context builders do it: every comment / chat / discussion
// query filters deletedAt: null. Deleted content is invisible to agents
// regardless of which path serves it.
//
// The default task response is deliberately a bounded working set. Long-lived
// tasks can accumulate hundreds of retries, chat rows and activity payloads;
// returning all of them on every fresh execution episode makes recovery spend
// its context window rediscovering old work. `history=full` remains available
// for explicit historical investigation, but must never be the routine path.

import { db } from "@/lib/db";
import { latestTaskExecutionCheckpoint, type TaskExecutionEpisodeSummary } from "@/lib/agents/episodes/lifecycle";
import { parseAcceptanceCriteria } from "@/lib/tasks/action-plan-store";
import { effectiveCommitPrefix, effectiveTaskCommitPrefix } from "@/lib/work-items/keys";
import { effectiveEpicBranchName, effectiveTaskBranchName } from "@/lib/work-items/branches";
import { isActionableEpicStatus } from "@/lib/tasks/workflow-actors";
import { resolveAgentTaskAccess } from "@/lib/agents/private-task-access";

export type TaskContextHistoryMode = "recent" | "full";

const RECENT_LIMITS = {
  comments: 8,
  liveChats: 10,
  archivedChats: 2,
  activity: 12,
  timelineBody: 3_000,
  activityPayload: 1_000,
  description: 8_000,
} as const;

const FULL_LIMITS = {
  comments: 2000,
  liveChats: 2000,
  archivedChats: 2000,
  activity: 500,
  timelineBody: 24_000,
  activityPayload: 12_000,
  description: 60_000,
} as const;

// Epic/project serializers keep their existing generous explicit-context
// contract. Only task history has the pathological retry amplification this
// bounded default is intended to stop.
const MAX_COMMENTS = FULL_LIMITS.comments;
const MAX_LIVE_CHATS = FULL_LIMITS.liveChats;
const MAX_ARCHIVED_CHATS = FULL_LIMITS.archivedChats;
const API_TIMELINE_BODY_MAX = FULL_LIMITS.timelineBody;
const API_DESCRIPTION_MAX = FULL_LIMITS.description;

export function taskContextLimits(mode: TaskContextHistoryMode) {
  return mode === "full" ? FULL_LIMITS : RECENT_LIMITS;
}

const MAX_ATTACHMENTS = 200;
const ARCHIVE_CHAIN_DEPTH = 8;

type ActorLite = { username: string | null; kind: string | null; isOwner?: boolean } | null;

function clipApi(value: string | null | undefined, max: number) {
  const text = (value ?? "").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max).trimEnd()}\n[truncated: ${text.length - max} more chars]`;
}

function actor(u: ActorLite) {
  if (!u || !u.username) return null;
  return { username: u.username, kind: u.kind ?? "human", isOwner: Boolean(u.isOwner) };
}

function attachmentDownloadPath(
  id: string,
  grant?: string | null,
  scope?: { type: "task" | "epic"; id: string } | null,
) {
  const path = `/api/attachments/${id}`;
  if (!grant) return path;
  const params = new URLSearchParams({
    grant,
    scopeType: scope?.type ?? "",
    scopeId: scope?.id ?? "",
  });
  return `${path}?${params.toString()}`;
}

type ParsedActivityPayload = unknown;
function parseActivityPayload(raw: string | null): ParsedActivityPayload {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ParsedActivityPayload;
  } catch {
    return raw;
  }
}

// ───────────────────────────────────────────────────────────────────────
// Task
// ───────────────────────────────────────────────────────────────────────

export interface TaskContextResponse {
  /** Full history only, scoped to the authenticated agent. */
  checkpoint?: TaskExecutionEpisodeSummary["checkpoint"] & { episodeNo: number; status: string };
  task: {
    id: string;
    workItemKey: string | null;
    title: string;
    status: string;
    approved_on: string | null;
    approvedOn: string | null;
    alert_reporter: boolean;
    description: string | null;
    branchName: string | null;
    commitPrefix: string | null;
    createdAt: string;
    updatedAt: string;
    assignee: ReturnType<typeof actor>;
    reviewer: ReturnType<typeof actor>;
    reporter: ReturnType<typeof actor>;
  };
  project: {
    id: string;
    slug: string;
    name: string;
    description: string | null;
    readmePath: string | null;
    repositoryPath: string | null;
  };
  epic: null | {
    id: string;
    workItemKey: string | null;
    title: string;
    status: string;
    description: string | null;
    branchName: string | null;
    commitPrefix: string | null;
    completionReviewStatus: string;
    completionReviewCandidateSha: string | null;
    completionReviewLastError: string | null;
    workers: Array<ReturnType<typeof actor>>;
    actingManager: ReturnType<typeof actor>;
    deployReviewer: ReturnType<typeof actor>;
  };
  // Canonical plan, independent of clipped discussion/history. A fresh
  // execution episode must be able to retrieve every acceptance criterion.
  actionPlan: null | {
    id: string;
    version: number;
    status: string;
    summary: string;
    approvedOn: string | null;
    approvedById: string | null;
    steps: Array<{
      id: string;
      stepId: string;
      title: string;
      acceptanceCriteria: string[];
      kind: string;
      assigneeId: string | null;
      rank: number;
    }>;
  };
  checklist: Array<{ id: string; text: string; done: boolean; minutes: number | null }>;
  comments: Array<{
    id: string;
    createdAt: string;
    author: ReturnType<typeof actor>;
    body: string;
  }>;
  discussion: Array<{
    id: string;
    createdAt: string;
    sender: ReturnType<typeof actor>;
    body: string;
    targetType: string | null;
    targetLabel: string | null;
    archived: boolean;
    archiveId: string | null;
  }>;
  activity: Array<{
    id: string;
    createdAt: string;
    kind: string;
    actor: ReturnType<typeof actor>;
    targetAgent: string | null;
    payload: ParsedActivityPayload;
  }>;
  attachments: Array<{
    id: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    uploader: ReturnType<typeof actor>;
    createdAt: string;
    scope?: "task" | "epic";
    downloadPath: string;
  }>;
  /**
   * PRIORITY CONTEXT — the last few non-deleted discussion messages
   * (oldest-first). This is the conversational hot path the agent is
   * replying inside. Same rows are also present in `discussion`; this
   * is a denormalised pointer so callers don't have to scan the full
   * 2000-row array to find "what just happened".
   */
  currentThread: Array<{
    id: string;
    createdAt: string;
    sender: ReturnType<typeof actor>;
    body: string;
    targetType: string | null;
    targetLabel: string | null;
  }>;
  /**
   * PRIORITY CONTEXT — the last few non-deleted comments (oldest-first).
   * Same rows are also present in `comments`. Treat as primary if the
   * current message is a reply to a comment.
   */
  recentComments: Array<{
    id: string;
    createdAt: string;
    author: ReturnType<typeof actor>;
    body: string;
  }>;
  meta: {
    fetchedAt: string;
    historyMode?: TaskContextHistoryMode;
    limits?: ReturnType<typeof taskContextLimits>;
    note: string;
    /** Present on task / epic responses to flag the recent-exchange slice. Absent on project. */
    priorityNote?: string;
  };
}

export async function buildTaskContextJson(
  taskId: string,
  opts: {
    attachmentGrant?: string | null;
    historyMode?: TaskContextHistoryMode;
    agentSlug?: string | null;
  } = {},
): Promise<TaskContextResponse | null> {
  const historyMode = opts.historyMode ?? "recent";
  const limits = taskContextLimits(historyMode);
  const access = await resolveAgentTaskAccess({ taskId, agentSlug: opts.agentSlug });
  if (!access.allowed) return null;
  const task = await db.task.findFirst({
    where: {
      id: taskId,
      archivedAt: null,
      deletedAt: null,
    },
    select: {
      id: true, title: true, status: true, description: true, branchName: true,
      commitPrefix: true, workItemKey: true, approvedOn: true, alertReporter: true, createdAt: true, updatedAt: true,
      project: {
        select: {
          id: true, slug: true, name: true, description: true,
          readmePath: true, repositoryPath: true,
        },
      },
      epic: {
        select: {
          id: true, workItemKey: true, title: true, status: true, description: true,
          branchName: true, commitPrefix: true,
          completionReviewStatus: true, completionReviewCandidateSha: true, completionReviewLastError: true,
          workers: {
            orderBy: { createdAt: "asc" },
            select: { user: { select: { username: true, kind: true, isOwner: true } } },
          },
          actingManager: { select: { username: true, kind: true, isOwner: true } },
          deployReviewer: { select: { username: true, kind: true, isOwner: true } },
        },
      },
      actionPlan: {
        select: {
          id: true, version: true, status: true, summary: true,
          approvedOn: true, approvedById: true,
          steps: {
            orderBy: { rank: "asc" },
            select: {
              id: true, stepId: true, title: true, acceptanceCriteria: true,
              kind: true, assigneeId: true, rank: true,
            },
          },
        },
      },
      checklist: {
        orderBy: { rank: "asc" },
        select: { id: true, text: true, completedAt: true, minutesSpent: true },
      },
      assignee: { select: { username: true, kind: true, isOwner: true } },
      actingManager: { select: { username: true, kind: true, isOwner: true } },
      reporter: { select: { username: true, kind: true, isOwner: true } },
    },
  });
  if (!task) return null;

  const resolvedReviewer = task.actingManager
    ?? (isActionableEpicStatus(task.epic?.status) ? task.epic?.actingManager ?? null : null)
    ?? task.reporter;

  const [comments, liveChats, activity, taskAttachments, epicAttachments] = await Promise.all([
    db.comment.findMany({
      where: { taskId, deletedAt: null },
      orderBy: { createdAt: "desc" },
      take: limits.comments,
      select: {
        id: true, createdAt: true, body: true,
        user: { select: { username: true, kind: true, isOwner: true } },
      },
    }),
    db.agentChatMessage.findMany({
      where: { taskId, archiveId: null, deletedAt: null },
      orderBy: { createdAt: "desc" },
      take: limits.liveChats,
      select: {
        id: true, createdAt: true, body: true,
        targetType: true, targetLabel: true, archiveId: true,
        sender: { select: { username: true, kind: true, isOwner: true } },
      },
    }),
    db.activityLog.findMany({
      where: { taskId },
      orderBy: { createdAt: "desc" },
      take: limits.activity,
      select: {
        id: true, createdAt: true, kind: true, payload: true, targetAgent: true,
        user: { select: { username: true, kind: true, isOwner: true } },
      },
    }),
    access.attachmentsAllowed
      ? db.attachment.findMany({
          where: { taskId },
          orderBy: { createdAt: "desc" },
          take: MAX_ATTACHMENTS,
          select: {
            id: true, filename: true, mimeType: true, sizeBytes: true,
            createdAt: true,
            uploader: { select: { username: true, kind: true, isOwner: true } },
          },
        })
      : Promise.resolve([]),
    task.epic && access.attachmentsAllowed
      ? db.attachment.findMany({
          where: { epicId: task.epic.id },
          orderBy: { createdAt: "desc" },
          take: MAX_ATTACHMENTS,
          select: {
            id: true, filename: true, mimeType: true, sizeBytes: true,
            createdAt: true,
            uploader: { select: { username: true, kind: true, isOwner: true } },
          },
        })
      : Promise.resolve([]),
  ]);

  // The caps keep the NEWEST N rows (queries run desc); flip back to
  // chronological order for presentation. Activity stays newest-first.
  comments.reverse();
  liveChats.reverse();
  taskAttachments.reverse();
  epicAttachments.reverse();

  // Archive chain (active room's ancestors), walked by baseArchiveId from
  // the most recent live message. Capped depth so a long chain doesn't
  // explode the response.
  let archivedChats: Array<{
    id: string;
    createdAt: Date;
    body: string;
    targetType: string | null;
    targetLabel: string | null;
    archiveId: string | null;
    sender: { username: string | null; kind: string | null; isOwner?: boolean } | null;
  }> = [];
  const lastLive = liveChats.at(-1);
  if (lastLive) {
    const seed = await db.agentChatMessage.findUnique({
      where: { id: lastLive.id },
      select: { baseArchiveId: true },
    });
    if (seed?.baseArchiveId) {
      const archiveIds: string[] = [];
      const seen = new Set<string>();
      let cursor: string | null = seed.baseArchiveId;
      while (cursor && !seen.has(cursor) && archiveIds.length < ARCHIVE_CHAIN_DEPTH) {
        seen.add(cursor);
        const archive: { id: string; parentArchiveId: string | null } | null = await db.agentChatRoomArchive.findFirst({
          where: { id: cursor, taskId, deletedAt: null },
          select: { id: true, parentArchiveId: true },
        });
        if (!archive) break;
        archiveIds.unshift(archive.id);
        cursor = archive.parentArchiveId;
      }
      if (archiveIds.length > 0) {
        archivedChats = (await db.agentChatMessage.findMany({
          where: {
            taskId,
            archiveId: { in: archiveIds },
            deletedAt: null,
          },
          orderBy: { createdAt: "desc" },
          take: limits.archivedChats,
          select: {
            id: true, createdAt: true, body: true,
            targetType: true, targetLabel: true, archiveId: true,
            sender: { select: { username: true, kind: true, isOwner: true } },
          },
        })).reverse();
      }
    }
  }

  const checkpoint = historyMode === "full" && opts.agentSlug
    ? await latestTaskExecutionCheckpoint({ taskId, agentSlug: opts.agentSlug })
    : null;

  return {
    ...(checkpoint ? { checkpoint: { ...checkpoint.checkpoint, episodeNo: checkpoint.episodeNo, status: checkpoint.status } } : {}),
    task: {
      id: task.id,
      workItemKey: task.workItemKey,
      title: task.title,
      status: task.status,
      approved_on: task.approvedOn?.toISOString() ?? null,
      approvedOn: task.approvedOn?.toISOString() ?? null,
      alert_reporter: task.alertReporter,
      description: clipApi(task.description, limits.description),
      branchName: effectiveTaskBranchName(task),
      commitPrefix: effectiveTaskCommitPrefix(task),
      createdAt: task.createdAt.toISOString(),
      updatedAt: task.updatedAt.toISOString(),
      assignee: actor(task.assignee),
      reviewer: actor(resolvedReviewer),
      reporter: actor(task.reporter),
    },
    project: {
      id: task.project.id,
      slug: task.project.slug,
      name: task.project.name,
      description: clipApi(task.project.description, limits.description),
      readmePath: task.project.readmePath,
      repositoryPath: task.project.repositoryPath,
    },
    epic: task.epic
      ? {
          id: task.epic.id,
          workItemKey: task.epic.workItemKey,
          title: task.epic.title,
          status: task.epic.status,
          description: clipApi(task.epic.description, limits.description),
          branchName: effectiveEpicBranchName(task.epic),
          commitPrefix: effectiveCommitPrefix({
            commitPrefix: task.epic.commitPrefix,
            workItemKey: task.epic.workItemKey,
          }),
          completionReviewStatus: task.epic.completionReviewStatus,
          completionReviewCandidateSha: task.epic.completionReviewCandidateSha,
          completionReviewLastError: task.epic.completionReviewLastError,
          workers: task.epic.workers.map((worker) => actor(worker.user)),
          actingManager: actor(task.epic.actingManager),
          deployReviewer: actor(task.epic.deployReviewer),
        }
      : null,
    actionPlan: task.actionPlan
      ? {
          ...task.actionPlan,
          approvedOn: task.actionPlan.approvedOn?.toISOString() ?? null,
          steps: task.actionPlan.steps.map((step) => ({
            ...step,
            acceptanceCriteria: parseAcceptanceCriteria(step.acceptanceCriteria),
          })),
        }
      : null,
    checklist: task.checklist.map((s) => ({
      id: s.id,
      text: s.text,
      done: s.completedAt !== null,
      minutes: s.minutesSpent ?? null,
    })),
    comments: comments.map((c) => ({
      id: c.id,
      createdAt: c.createdAt.toISOString(),
      author: actor(c.user),
      body: clipApi(c.body, limits.timelineBody),
    })),
    discussion: [
      ...archivedChats.map((m) => ({
        id: m.id,
        createdAt: m.createdAt.toISOString(),
        sender: actor(m.sender),
        body: clipApi(m.body, limits.timelineBody),
        targetType: m.targetType,
        targetLabel: m.targetLabel,
        archived: true,
        archiveId: m.archiveId,
      })),
      ...liveChats.map((m) => ({
        id: m.id,
        createdAt: m.createdAt.toISOString(),
        sender: actor(m.sender),
        body: clipApi(m.body, limits.timelineBody),
        targetType: m.targetType,
        targetLabel: m.targetLabel,
        archived: false,
        archiveId: null,
      })),
    ],
    activity: activity.map((a) => ({
      id: a.id,
      createdAt: a.createdAt.toISOString(),
      kind: a.kind,
      actor: actor(a.user),
      targetAgent: a.targetAgent,
      payload: parseActivityPayload(clipApi(a.payload, limits.activityPayload)),
    })),
    attachments: [
      ...taskAttachments.map((a) => ({
        id: a.id,
        filename: a.filename,
        mimeType: a.mimeType,
        sizeBytes: a.sizeBytes,
        uploader: actor(a.uploader),
        createdAt: a.createdAt.toISOString(),
        scope: "task" as const,
        downloadPath: attachmentDownloadPath(a.id, opts.attachmentGrant, {
          type: "task",
          id: taskId,
        }),
      })),
      ...epicAttachments.map((a) => ({
        id: a.id,
        filename: a.filename,
        mimeType: a.mimeType,
        sizeBytes: a.sizeBytes,
        uploader: actor(a.uploader),
        createdAt: a.createdAt.toISOString(),
        scope: "epic" as const,
        downloadPath: attachmentDownloadPath(a.id, opts.attachmentGrant, {
          type: "task",
          id: taskId,
        }),
      })),
    ],
    currentThread: liveChats.slice(-5).map((m) => ({
      id: m.id,
      createdAt: m.createdAt.toISOString(),
      sender: actor(m.sender),
      body: clipApi(m.body, limits.timelineBody),
      targetType: m.targetType,
      targetLabel: m.targetLabel,
    })),
    recentComments: comments.slice(-3).map((c) => ({
      id: c.id,
      createdAt: c.createdAt.toISOString(),
      author: actor(c.user),
      body: clipApi(c.body, limits.timelineBody),
    })),
    meta: {
      fetchedAt: new Date().toISOString(),
      historyMode,
      limits,
      note: historyMode === "full"
        ? "Explicit full-history view. Soft-deleted rows are filtered server-side; discussion is oldest-first and activity newest-first."
        : "Bounded recent working set. Soft-deleted rows are filtered server-side; discussion is oldest-first and activity newest-first. Add ?history=full only when older evidence is specifically required.",
      priorityNote: "currentThread + recentComments are the immediate conversational hot path. If you proposed a scope in the last few messages and the user agreed, MATCH THAT SCOPE EXACTLY — do not silently widen it. Surface a question first if you need to deviate.",
    },
  };
}

// ───────────────────────────────────────────────────────────────────────
// Epic
// ───────────────────────────────────────────────────────────────────────

export interface EpicContextResponse {
  epic: {
    id: string;
    workItemKey: string | null;
    title: string;
    status: string;
    description: string | null;
    branchName: string | null;
    commitPrefix: string | null;
    completionReviewStatus: string;
    completionReviewCandidateSha: string | null;
    completionReviewLastError: string | null;
    createdAt: string;
    updatedAt: string;
    workers: Array<ReturnType<typeof actor>>;
    actingManager: ReturnType<typeof actor>;
    deployReviewer: ReturnType<typeof actor>;
    reporter: ReturnType<typeof actor>;
  };
  project: TaskContextResponse["project"];
  tasks: Array<{
    id: string;
    workItemKey: string | null;
    title: string;
    status: string;
    assignee: ReturnType<typeof actor>;
  }>;
  comments: TaskContextResponse["comments"];
  discussion: TaskContextResponse["discussion"];
  attachments: TaskContextResponse["attachments"];
  currentThread: TaskContextResponse["currentThread"];
  recentComments: TaskContextResponse["recentComments"];
  meta: TaskContextResponse["meta"];
}

export async function buildEpicContextJson(
  epicId: string,
  opts: { attachmentGrant?: string | null } = {},
): Promise<EpicContextResponse | null> {
  const epic = await db.epic.findFirst({
    where: { id: epicId, archivedAt: null, deletedAt: null, private: false },
    select: {
      id: true, title: true, status: true, description: true, branchName: true,
      commitPrefix: true, workItemKey: true, createdAt: true, updatedAt: true,
      completionReviewStatus: true, completionReviewCandidateSha: true, completionReviewLastError: true,
      project: {
        select: {
          id: true, slug: true, name: true, description: true,
          readmePath: true, repositoryPath: true,
        },
      },
      workers: {
        orderBy: { createdAt: "asc" },
        select: { user: { select: { username: true, kind: true, isOwner: true } } },
      },
      actingManager: { select: { username: true, kind: true, isOwner: true } },
      deployReviewer: { select: { username: true, kind: true, isOwner: true } },
      reporter: { select: { username: true, kind: true, isOwner: true } },
      tasks: {
        where: { deletedAt: null, parentTaskId: null, private: false },
        orderBy: [{ rank: "asc" }, { createdAt: "asc" }],
        select: {
          id: true, workItemKey: true, title: true, status: true,
          assignee: { select: { username: true, kind: true, isOwner: true } },
        },
      },
    },
  });
  if (!epic) return null;

  const [comments, liveChats, attachments] = await Promise.all([
    db.comment.findMany({
      where: { epicId, deletedAt: null },
      orderBy: { createdAt: "desc" },
      take: MAX_COMMENTS,
      select: {
        id: true, createdAt: true, body: true,
        user: { select: { username: true, kind: true, isOwner: true } },
      },
    }),
    db.agentChatMessage.findMany({
      where: { epicId, archiveId: null, deletedAt: null },
      orderBy: { createdAt: "desc" },
      take: MAX_LIVE_CHATS,
      select: {
        id: true, createdAt: true, body: true,
        targetType: true, targetLabel: true, archiveId: true,
        sender: { select: { username: true, kind: true, isOwner: true } },
      },
    }),
    db.attachment.findMany({
      where: { epicId },
      orderBy: { createdAt: "desc" },
      take: MAX_ATTACHMENTS,
      select: {
        id: true, filename: true, mimeType: true, sizeBytes: true,
        createdAt: true,
        uploader: { select: { username: true, kind: true, isOwner: true } },
      },
    }),
  ]);

  // The caps keep the NEWEST N rows (queries run desc); flip back to
  // chronological order for presentation.
  comments.reverse();
  liveChats.reverse();
  attachments.reverse();

  // Archive chain (active room's ancestors), walked by baseArchiveId from
  // the most recent live message. Keep Epic live-fetch parity with the
  // rendered Epic context builder so archived discussion is not bypassed.
  let archivedChats: Array<{
    id: string;
    createdAt: Date;
    body: string;
    targetType: string | null;
    targetLabel: string | null;
    archiveId: string | null;
    sender: { username: string | null; kind: string | null; isOwner?: boolean } | null;
  }> = [];
  const lastLive = liveChats.at(-1);
  if (lastLive) {
    const seed = await db.agentChatMessage.findUnique({
      where: { id: lastLive.id },
      select: { baseArchiveId: true },
    });
    if (seed?.baseArchiveId) {
      const archiveIds: string[] = [];
      const seen = new Set<string>();
      let cursor: string | null = seed.baseArchiveId;
      while (cursor && !seen.has(cursor) && archiveIds.length < ARCHIVE_CHAIN_DEPTH) {
        seen.add(cursor);
        const archive: { id: string; parentArchiveId: string | null } | null = await db.agentChatRoomArchive.findFirst({
          where: { id: cursor, epicId, deletedAt: null },
          select: { id: true, parentArchiveId: true },
        });
        if (!archive) break;
        archiveIds.unshift(archive.id);
        cursor = archive.parentArchiveId;
      }
      if (archiveIds.length > 0) {
        archivedChats = (await db.agentChatMessage.findMany({
          where: {
            epicId,
            archiveId: { in: archiveIds },
            deletedAt: null,
          },
          orderBy: { createdAt: "desc" },
          take: MAX_ARCHIVED_CHATS,
          select: {
            id: true, createdAt: true, body: true,
            targetType: true, targetLabel: true, archiveId: true,
            sender: { select: { username: true, kind: true, isOwner: true } },
          },
        })).reverse();
      }
    }
  }

  return {
    epic: {
      id: epic.id,
      workItemKey: epic.workItemKey,
      title: epic.title,
      status: epic.status,
      description: clipApi(epic.description, API_DESCRIPTION_MAX),
      branchName: effectiveEpicBranchName(epic),
      commitPrefix: effectiveCommitPrefix({
        commitPrefix: epic.commitPrefix,
        workItemKey: epic.workItemKey,
      }),
      completionReviewStatus: epic.completionReviewStatus,
      completionReviewCandidateSha: epic.completionReviewCandidateSha,
      completionReviewLastError: epic.completionReviewLastError,
      createdAt: epic.createdAt.toISOString(),
      updatedAt: epic.updatedAt.toISOString(),
      workers: epic.workers.map((worker) => actor(worker.user)),
      actingManager: actor(epic.actingManager),
      deployReviewer: actor(epic.deployReviewer),
      reporter: actor(epic.reporter),
    },
    project: {
      id: epic.project.id,
      slug: epic.project.slug,
      name: epic.project.name,
      description: clipApi(epic.project.description, API_DESCRIPTION_MAX),
      readmePath: epic.project.readmePath,
      repositoryPath: epic.project.repositoryPath,
    },
    tasks: epic.tasks.map((t) => ({
      id: t.id,
      workItemKey: t.workItemKey,
      title: t.title,
      status: t.status,
      assignee: actor(t.assignee),
    })),
    comments: comments.map((c) => ({
      id: c.id,
      createdAt: c.createdAt.toISOString(),
      author: actor(c.user),
      body: clipApi(c.body, API_TIMELINE_BODY_MAX),
    })),
    discussion: [
      ...archivedChats.map((m) => ({
        id: m.id,
        createdAt: m.createdAt.toISOString(),
        sender: actor(m.sender),
        body: clipApi(m.body, API_TIMELINE_BODY_MAX),
        targetType: m.targetType,
        targetLabel: m.targetLabel,
        archived: true,
        archiveId: m.archiveId,
      })),
      ...liveChats.map((m) => ({
        id: m.id,
        createdAt: m.createdAt.toISOString(),
        sender: actor(m.sender),
        body: clipApi(m.body, API_TIMELINE_BODY_MAX),
        targetType: m.targetType,
        targetLabel: m.targetLabel,
        archived: false,
        archiveId: null,
      })),
    ],
    attachments: attachments.map((a) => ({
      id: a.id,
      filename: a.filename,
      mimeType: a.mimeType,
      sizeBytes: a.sizeBytes,
      uploader: actor(a.uploader),
      createdAt: a.createdAt.toISOString(),
      scope: "epic",
      downloadPath: attachmentDownloadPath(a.id, opts.attachmentGrant, {
        type: "epic",
        id: epicId,
      }),
    })),
    currentThread: liveChats.slice(-5).map((m) => ({
      id: m.id,
      createdAt: m.createdAt.toISOString(),
      sender: actor(m.sender),
      body: clipApi(m.body, API_TIMELINE_BODY_MAX),
      targetType: m.targetType,
      targetLabel: m.targetLabel,
    })),
    recentComments: comments.slice(-3).map((c) => ({
      id: c.id,
      createdAt: c.createdAt.toISOString(),
      author: actor(c.user),
      body: clipApi(c.body, API_TIMELINE_BODY_MAX),
    })),
    meta: {
      fetchedAt: new Date().toISOString(),
      note: "Soft-deleted comments / discussion are filtered server-side. Discussion is oldest-first.",
      priorityNote: "currentThread + recentComments are the immediate conversational hot path. If you proposed a scope in the last few messages and the user agreed, MATCH THAT SCOPE EXACTLY — do not silently widen it. Surface a question first if you need to deviate.",
    },
  };
}

// ───────────────────────────────────────────────────────────────────────
// Project
// ───────────────────────────────────────────────────────────────────────

export interface ProjectContextResponse {
  project: TaskContextResponse["project"];
  defaultGitIdentity: { name: string | null; email: string | null };
  principals: Array<{ id: string; username: string; kind: string }>;
  epics: Array<{
    id: string;
    workItemKey: string | null;
    title: string;
    status: string;
    description: string | null;
    branchName: string | null;
    commitPrefix: string | null;
    completionReviewStatus: string;
    completionReviewCandidateSha: string | null;
    workers: Array<ReturnType<typeof actor>>;
    actingManager: ReturnType<typeof actor>;
    deployReviewer: ReturnType<typeof actor>;
  }>;
  openTasks: Array<{
    id: string;
    workItemKey: string | null;
    title: string;
    status: string;
    epicId: string | null;
    parentTaskId: string | null;
    assignee: ReturnType<typeof actor>;
    actingManager: ReturnType<typeof actor>;
    branchName: string | null;
    commitPrefix: string | null;
  }>;
  meta: TaskContextResponse["meta"];
}

export async function buildProjectContextJson(projectId: string): Promise<ProjectContextResponse | null> {
  const project = await db.project.findUnique({
    where: { id: projectId, deletedAt: null },
    select: {
      id: true, slug: true, name: true, description: true,
      readmePath: true, repositoryPath: true,
      defaultGitUserName: true, defaultGitUserEmail: true,
      workItemKeyPrefix: true,
    },
  });
  if (!project) return null;

  const [epics, openTasks, principals] = await Promise.all([
    db.epic.findMany({
      where: { projectId, archivedAt: null, deletedAt: null, private: false },
      orderBy: [{ status: "asc" }, { createdAt: "asc" }],
      select: {
        id: true, workItemKey: true, title: true, status: true, description: true,
        branchName: true, commitPrefix: true,
        completionReviewStatus: true, completionReviewCandidateSha: true,
        workers: {
          orderBy: { createdAt: "asc" },
          select: { user: { select: { username: true, kind: true, isOwner: true } } },
        },
        actingManager: { select: { username: true, kind: true, isOwner: true } },
        deployReviewer: { select: { username: true, kind: true, isOwner: true } },
      },
    }),
    db.task.findMany({
      where: {
        projectId,
        parentTaskId: null,
        status: { not: "Done" },
        archivedAt: null,
        deletedAt: null,
        private: false,
        OR: [{ epicId: null }, { epic: { private: false } }],
      },
      orderBy: [{ rank: "asc" }, { createdAt: "asc" }],
      select: {
        id: true, workItemKey: true, title: true, status: true, epicId: true, parentTaskId: true,
        branchName: true, commitPrefix: true,
        epic: { select: { workItemKey: true, branchName: true, commitPrefix: true } },
        assignee: { select: { username: true, kind: true, isOwner: true } },
        actingManager: { select: { username: true, kind: true, isOwner: true } },
      },
    }),
    db.user.findMany({
      where: { status: "active" },
      select: { id: true, username: true, kind: true },
      orderBy: { username: "asc" },
    }),
  ]);

  return {
    project: {
      id: project.id,
      slug: project.slug,
      name: project.name,
      description: clipApi(project.description, API_DESCRIPTION_MAX),
      readmePath: project.readmePath,
      repositoryPath: project.repositoryPath,
    },
    defaultGitIdentity: {
      name: project.defaultGitUserName,
      email: project.defaultGitUserEmail,
    },
    principals: principals.map((p) => ({ id: p.id, username: p.username, kind: p.kind })),
    epics: epics.map((e) => ({
      id: e.id,
      workItemKey: e.workItemKey,
      title: e.title,
      status: e.status,
      description: clipApi(e.description, API_DESCRIPTION_MAX),
      branchName: effectiveEpicBranchName(e),
      commitPrefix: effectiveCommitPrefix({ commitPrefix: e.commitPrefix, workItemKey: e.workItemKey }),
      completionReviewStatus: e.completionReviewStatus,
      completionReviewCandidateSha: e.completionReviewCandidateSha,
      workers: e.workers.map((worker) => actor(worker.user)),
      actingManager: actor(e.actingManager),
      deployReviewer: actor(e.deployReviewer),
    })),
    openTasks: openTasks.map((t) => ({
      id: t.id,
      workItemKey: t.workItemKey,
      title: t.title,
      status: t.status,
      epicId: t.epicId,
      parentTaskId: t.parentTaskId,
      assignee: actor(t.assignee),
      actingManager: actor(t.actingManager),
      branchName: effectiveTaskBranchName(t),
      commitPrefix: effectiveTaskCommitPrefix(t),
    })),
    meta: {
      fetchedAt: new Date().toISOString(),
      note: "Only top-level open tasks (status != Done, parentTaskId null) are listed. Use the task endpoint for full per-task and sub-task detail.",
    },
  };
}
