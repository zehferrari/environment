// JSON serializers for the agent-facing PM read API.
//
// These are intentionally data-only — no markdown rendering, no clipping,
// no manifest preamble. Agents fetch JSON they can parse and quote from
// directly. The output shape is documented in
// ai/web/docs/agent-pm-api.md and is the contract agents code against.
//
// Soft-delete (HOMELAB-41 / item 2) is enforced HERE the same way the
// rendered-context builders do it: every comment / chat / discussion
// query filters deletedAt: null. Deleted content is invisible to agents
// regardless of which path serves it.
//
// Sized for 1M-token-window callers (Claude Opus 4.7 / OpenAI gpt-5.5).
// No per-body clipping — full bodies returned. Older content beyond the
// row caps below will be omitted; if you need history older than the
// caps, page via ?before=<isoTimestamp> (Phase 2 — not yet implemented).

import { db } from "@/lib/db";
import { effectiveCommitPrefix } from "@/lib/work-items/keys";

// Generous caps — 99th-percentile tasks fit comfortably. PM database is
// SQLite, all on local NVMe; reading 2k rows is sub-100ms.
const MAX_COMMENTS = 2000;
const MAX_LIVE_CHATS = 2000;
const MAX_ARCHIVED_CHATS = 2000;
const MAX_ACTIVITY = 500;
const MAX_ATTACHMENTS = 200;
const ARCHIVE_CHAIN_DEPTH = 8;

type ActorLite = { username: string | null; kind: string | null } | null;

function actor(u: ActorLite) {
  if (!u || !u.username) return null;
  return { username: u.username, kind: u.kind ?? "human" };
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
    workers: Array<ReturnType<typeof actor>>;
    actingManager: ReturnType<typeof actor>;
  };
  parentTask: null | { id: string; title: string; status: string };
  subtasks: Array<{ id: string; title: string; status: string; assignee: ReturnType<typeof actor> }>;
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
    note: string;
    /** Present on task / epic responses to flag the recent-exchange slice. Absent on project. */
    priorityNote?: string;
  };
}

export async function buildTaskContextJson(
  taskId: string,
  opts: { attachmentGrant?: string | null } = {},
): Promise<TaskContextResponse | null> {
  const task = await db.task.findUnique({
    where: { id: taskId, archivedAt: null, deletedAt: null },
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
          workers: {
            orderBy: { createdAt: "asc" },
            select: { user: { select: { username: true, kind: true } } },
          },
          actingManager: { select: { username: true, kind: true } },
        },
      },
      parent: { select: { id: true, title: true, status: true } },
      subtasks: {
        where: { archivedAt: null, deletedAt: null },
        orderBy: [{ status: "asc" }, { rank: "asc" }, { createdAt: "asc" }],
        select: {
          id: true, title: true, status: true,
          assignee: { select: { username: true, kind: true } },
        },
      },
      assignee: { select: { username: true, kind: true } },
      actingManager: { select: { username: true, kind: true } },
      reporter: { select: { username: true, kind: true } },
    },
  });
  if (!task) return null;

  const [comments, liveChats, activity, taskAttachments, epicAttachments] = await Promise.all([
    db.comment.findMany({
      where: { taskId, deletedAt: null },
      orderBy: { createdAt: "asc" },
      take: MAX_COMMENTS,
      select: {
        id: true, createdAt: true, body: true,
        user: { select: { username: true, kind: true } },
      },
    }),
    db.agentChatMessage.findMany({
      where: { taskId, archiveId: null, deletedAt: null },
      orderBy: { createdAt: "asc" },
      take: MAX_LIVE_CHATS,
      select: {
        id: true, createdAt: true, body: true,
        targetType: true, targetLabel: true, archiveId: true,
        sender: { select: { username: true, kind: true } },
      },
    }),
    db.activityLog.findMany({
      where: { taskId },
      orderBy: { createdAt: "desc" },
      take: MAX_ACTIVITY,
      select: {
        id: true, createdAt: true, kind: true, payload: true, targetAgent: true,
        user: { select: { username: true, kind: true } },
      },
    }),
    db.attachment.findMany({
      where: { taskId },
      orderBy: { createdAt: "asc" },
      take: MAX_ATTACHMENTS,
      select: {
        id: true, filename: true, mimeType: true, sizeBytes: true,
        createdAt: true,
        uploader: { select: { username: true, kind: true } },
      },
    }),
    task.epic
      ? db.attachment.findMany({
          where: { epicId: task.epic.id },
          orderBy: { createdAt: "asc" },
          take: MAX_ATTACHMENTS,
          select: {
            id: true, filename: true, mimeType: true, sizeBytes: true,
            createdAt: true,
            uploader: { select: { username: true, kind: true } },
          },
        })
      : Promise.resolve([]),
  ]);

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
    sender: { username: string | null; kind: string | null } | null;
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
        archivedChats = await db.agentChatMessage.findMany({
          where: {
            taskId,
            archiveId: { in: archiveIds },
            deletedAt: null,
          },
          orderBy: { createdAt: "asc" },
          take: MAX_ARCHIVED_CHATS,
          select: {
            id: true, createdAt: true, body: true,
            targetType: true, targetLabel: true, archiveId: true,
            sender: { select: { username: true, kind: true } },
          },
        });
      }
    }
  }

  return {
    task: {
      id: task.id,
      workItemKey: task.workItemKey,
      title: task.title,
      status: task.status,
      approved_on: task.approvedOn?.toISOString() ?? null,
      approvedOn: task.approvedOn?.toISOString() ?? null,
      alert_reporter: task.alertReporter,
      description: task.description,
      branchName: task.branchName,
      commitPrefix: effectiveCommitPrefix({
        commitPrefix: task.commitPrefix ?? task.epic?.commitPrefix ?? null,
        workItemKey: task.workItemKey,
      }),
      createdAt: task.createdAt.toISOString(),
      updatedAt: task.updatedAt.toISOString(),
      assignee: actor(task.assignee),
      reviewer: actor(task.actingManager),
      reporter: actor(task.reporter),
    },
    project: {
      id: task.project.id,
      slug: task.project.slug,
      name: task.project.name,
      description: task.project.description,
      readmePath: task.project.readmePath,
      repositoryPath: task.project.repositoryPath,
    },
    epic: task.epic
      ? {
          id: task.epic.id,
          workItemKey: task.epic.workItemKey,
          title: task.epic.title,
          status: task.epic.status,
          description: task.epic.description,
          branchName: task.epic.branchName,
          commitPrefix: effectiveCommitPrefix({
            commitPrefix: task.epic.commitPrefix,
            workItemKey: task.epic.workItemKey,
          }),
          workers: task.epic.workers.map((worker) => actor(worker.user)),
          actingManager: actor(task.epic.actingManager),
        }
      : null,
    parentTask: task.parent ? { id: task.parent.id, title: task.parent.title, status: task.parent.status } : null,
    subtasks: task.subtasks.map((s) => ({
      id: s.id,
      title: s.title,
      status: s.status,
      assignee: actor(s.assignee),
    })),
    comments: comments.map((c) => ({
      id: c.id,
      createdAt: c.createdAt.toISOString(),
      author: actor(c.user),
      body: c.body,
    })),
    discussion: [
      ...archivedChats.map((m) => ({
        id: m.id,
        createdAt: m.createdAt.toISOString(),
        sender: actor(m.sender),
        body: m.body,
        targetType: m.targetType,
        targetLabel: m.targetLabel,
        archived: true,
        archiveId: m.archiveId,
      })),
      ...liveChats.map((m) => ({
        id: m.id,
        createdAt: m.createdAt.toISOString(),
        sender: actor(m.sender),
        body: m.body,
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
      payload: parseActivityPayload(a.payload),
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
      body: m.body,
      targetType: m.targetType,
      targetLabel: m.targetLabel,
    })),
    recentComments: comments.slice(-3).map((c) => ({
      id: c.id,
      createdAt: c.createdAt.toISOString(),
      author: actor(c.user),
      body: c.body,
    })),
    meta: {
      fetchedAt: new Date().toISOString(),
      note: "Soft-deleted comments / discussion / archives are filtered server-side. Discussion is oldest-first; activity is newest-first.",
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
    createdAt: string;
    updatedAt: string;
    workers: Array<ReturnType<typeof actor>>;
    actingManager: ReturnType<typeof actor>;
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
  const epic = await db.epic.findUnique({
    where: { id: epicId, archivedAt: null, deletedAt: null },
    select: {
      id: true, title: true, status: true, description: true, branchName: true,
      commitPrefix: true, workItemKey: true, createdAt: true, updatedAt: true,
      project: {
        select: {
          id: true, slug: true, name: true, description: true,
          readmePath: true, repositoryPath: true,
        },
      },
      workers: {
        orderBy: { createdAt: "asc" },
        select: { user: { select: { username: true, kind: true } } },
      },
      actingManager: { select: { username: true, kind: true } },
      reporter: { select: { username: true, kind: true } },
      tasks: {
        where: { deletedAt: null, parentTaskId: null },
        orderBy: [{ rank: "asc" }, { createdAt: "asc" }],
        select: {
          id: true, workItemKey: true, title: true, status: true,
          assignee: { select: { username: true, kind: true } },
        },
      },
    },
  });
  if (!epic) return null;

  const [comments, liveChats, attachments] = await Promise.all([
    db.comment.findMany({
      where: { epicId, deletedAt: null },
      orderBy: { createdAt: "asc" },
      take: MAX_COMMENTS,
      select: {
        id: true, createdAt: true, body: true,
        user: { select: { username: true, kind: true } },
      },
    }),
    db.agentChatMessage.findMany({
      where: { epicId, archiveId: null, deletedAt: null },
      orderBy: { createdAt: "asc" },
      take: MAX_LIVE_CHATS,
      select: {
        id: true, createdAt: true, body: true,
        targetType: true, targetLabel: true, archiveId: true,
        sender: { select: { username: true, kind: true } },
      },
    }),
    db.attachment.findMany({
      where: { epicId },
      orderBy: { createdAt: "asc" },
      take: MAX_ATTACHMENTS,
      select: {
        id: true, filename: true, mimeType: true, sizeBytes: true,
        createdAt: true,
        uploader: { select: { username: true, kind: true } },
      },
    }),
  ]);

  return {
    epic: {
      id: epic.id,
      workItemKey: epic.workItemKey,
      title: epic.title,
      status: epic.status,
      description: epic.description,
      branchName: epic.branchName,
      commitPrefix: effectiveCommitPrefix({
        commitPrefix: epic.commitPrefix,
        workItemKey: epic.workItemKey,
      }),
      createdAt: epic.createdAt.toISOString(),
      updatedAt: epic.updatedAt.toISOString(),
      workers: epic.workers.map((worker) => actor(worker.user)),
      actingManager: actor(epic.actingManager),
      reporter: actor(epic.reporter),
    },
    project: {
      id: epic.project.id,
      slug: epic.project.slug,
      name: epic.project.name,
      description: epic.project.description,
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
      body: c.body,
    })),
    discussion: liveChats.map((m) => ({
      id: m.id,
      createdAt: m.createdAt.toISOString(),
      sender: actor(m.sender),
      body: m.body,
      targetType: m.targetType,
      targetLabel: m.targetLabel,
      archived: false,
      archiveId: null,
    })),
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
      body: m.body,
      targetType: m.targetType,
      targetLabel: m.targetLabel,
    })),
    recentComments: comments.slice(-3).map((c) => ({
      id: c.id,
      createdAt: c.createdAt.toISOString(),
      author: actor(c.user),
      body: c.body,
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
    workers: Array<ReturnType<typeof actor>>;
    actingManager: ReturnType<typeof actor>;
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
      where: { projectId, archivedAt: null, deletedAt: null },
      orderBy: [{ status: "asc" }, { createdAt: "asc" }],
      select: {
        id: true, workItemKey: true, title: true, status: true, description: true,
        branchName: true, commitPrefix: true,
        workers: {
          orderBy: { createdAt: "asc" },
          select: { user: { select: { username: true, kind: true } } },
        },
        actingManager: { select: { username: true, kind: true } },
      },
    }),
    db.task.findMany({
      where: { projectId, parentTaskId: null, status: { not: "Done" }, archivedAt: null, deletedAt: null },
      orderBy: [{ rank: "asc" }, { createdAt: "asc" }],
      select: {
        id: true, workItemKey: true, title: true, status: true, epicId: true, parentTaskId: true,
        branchName: true, commitPrefix: true,
        assignee: { select: { username: true, kind: true } },
        actingManager: { select: { username: true, kind: true } },
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
      description: project.description,
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
      description: e.description,
      branchName: e.branchName,
      commitPrefix: effectiveCommitPrefix({ commitPrefix: e.commitPrefix, workItemKey: e.workItemKey }),
      workers: e.workers.map((worker) => actor(worker.user)),
      actingManager: actor(e.actingManager),
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
      branchName: t.branchName,
      commitPrefix: effectiveCommitPrefix({ commitPrefix: t.commitPrefix, workItemKey: t.workItemKey }),
    })),
    meta: {
      fetchedAt: new Date().toISOString(),
      note: "Only top-level open tasks (status != Done, parentTaskId null) are listed. Use the task endpoint for full per-task and sub-task detail.",
    },
  };
}
