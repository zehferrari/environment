import { revalidateTag, unstable_cache } from "next/cache";
import { db } from "@/lib/db";

type RepoVerifyActivityRow = {
  kind: string;
  payload: string | null;
  createdAt: Date | string | number | bigint | null;
};

type CreatedAtRow = {
  id?: string;
  createdAt: Date | string | number | bigint | null;
};

export const taskCacheTag = {
  shell: (taskId: string) => `task:${taskId}:shell`,
  comments: (taskId: string) => `task:${taskId}:comments`,
  attachments: (taskId: string) => `task:${taskId}:attachments`,
  activity: (taskId: string) => `task:${taskId}:activity`,
  chat: (taskId: string) => `task:${taskId}:chat`,
  chatArchives: (taskId: string) => `task:${taskId}:chat-archives`,
  proposals: (taskId: string) => `task:${taskId}:proposals`,
  description: (taskId: string) => `task:${taskId}:description`,
  projectEpics: (projectId: string) => `project:${projectId}:epics`,
} as const;

export type TaskReplyCacheScope = "chat" | "comment";
export type RevalidateTagFn = (tag: string) => void;

// Repository/checkpoint runners execute outside Next's request context, so
// their successful database writes cannot actively invalidate this cache.
// Keep tags for immediate in-process refreshes, but also bound external-runner
// staleness so a normal page refresh converges without a service restart.
export const TASK_SHELL_CACHE_REVALIDATE_SECONDS = 15;

export function tagsForTaskReplyScope(taskId: string, scope: TaskReplyCacheScope) {
  if (scope === "chat") {
    return [
      taskCacheTag.chat(taskId),
      taskCacheTag.chatArchives(taskId),
      taskCacheTag.proposals(taskId),
    ];
  }

  return [
    taskCacheTag.comments(taskId),
    taskCacheTag.activity(taskId),
  ];
}

export function revalidateTaskReplyScope(
  taskId: string,
  scope: TaskReplyCacheScope,
  revalidate: RevalidateTagFn = revalidateTag,
) {
  for (const tag of tagsForTaskReplyScope(taskId, scope)) {
    revalidate(tag);
  }
}

export function revalidateTaskShell(taskId: string, revalidate: RevalidateTagFn = revalidateTag) {
  revalidate(taskCacheTag.shell(taskId));
  revalidate(taskCacheTag.activity(taskId));
}

// Repository verification/finalization also calls task workflow helpers from
// standalone `tsx` runners. Next's cache invalidator has no static-generation
// async context there and throws after the database transition has already
// committed. Treat only that missing-context invariant as a cache no-op; real
// cache failures still surface. The board/data refresh remains best-effort for
// out-of-process mutations, but it must never turn handled review feedback
// into a failed repository spool job.
export function revalidateTaskShellIfAvailable(
  taskId: string,
  revalidate: RevalidateTagFn = revalidateTag,
) {
  try {
    revalidateTaskShell(taskId, revalidate);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/static generation store missing/i.test(message)) return false;
    throw error;
  }
}

export function revalidateTaskAttachments(taskId: string, revalidate: RevalidateTagFn = revalidateTag) {
  revalidate(taskCacheTag.attachments(taskId));
  revalidate(taskCacheTag.activity(taskId));
}

export function getCachedTaskDetailShell(taskId: string) {
  return unstable_cache(
    async () => db.task.findUnique({
      where: { id: taskId },
      include: {
        project: {
          select: {
            id: true,
            slug: true,
            name: true,
            repositoryPath: true,
            deploymentProductionBranch: true,
            onlyReportersCanApproveActionPlans: true,
            onlyReportersCanSetTasksDone: true,
            onlyReportersCanApprovePullRequests: true,
          },
        },
        assignee: {
          select: {
            id: true,
            username: true,
            name: true,
            kind: true,
            status: true,
            avatarUpdatedAt: true,
            agent: { select: { slug: true, role: true, deactivatedAt: true, name: true, avatar: true } },
          },
        },
        actingManager: {
          select: {
            id: true,
            username: true,
            name: true,
            kind: true,
            status: true,
            avatarUpdatedAt: true,
            agent: { select: { slug: true, role: true, deactivatedAt: true, name: true, avatar: true } },
          },
        },
        reporter: {
          select: {
            id: true,
            username: true,
            name: true,
            kind: true,
            status: true,
            avatarUpdatedAt: true,
            agent: { select: { slug: true, role: true, deactivatedAt: true, name: true, avatar: true } },
          },
        },
        approvedBy: {
          select: {
            id: true,
            username: true,
            name: true,
            kind: true,
            avatarUpdatedAt: true,
            agent: { select: { slug: true, name: true, avatar: true } },
          },
        },
        archivedBy: {
          select: {
            id: true,
            username: true,
            name: true,
            kind: true,
            avatarUpdatedAt: true,
            agent: { select: { slug: true, name: true, avatar: true } },
          },
        },
        epic: {
          select: {
            id: true,
            workItemKey: true,
            title: true,
            status: true,
            deploymentStatus: true,
            branchName: true,
            commitPrefix: true,
            actingManagerId: true,
            actingManager: {
              select: {
                id: true,
                username: true,
                name: true,
                kind: true,
                status: true,
                avatarUpdatedAt: true,
                agent: { select: { slug: true, role: true, deactivatedAt: true, name: true, avatar: true } },
              },
            },
          },
        },
        checklist: {
          orderBy: { rank: "asc" },
          select: {
            id: true,
            text: true,
            completedAt: true,
            minutesSpent: true,
            kind: true,
          },
        },
        actionPlan: {
          select: {
            id: true,
            summary: true,
            version: true,
            status: true,
            approvedOn: true,
            createdAt: true,
            updatedAt: true,
            author: {
              select: {
                id: true,
                username: true,
                name: true,
                kind: true,
                avatarUpdatedAt: true,
                agent: { select: { slug: true, name: true, avatar: true } },
              },
            },
            approvedBy: {
              select: {
                id: true,
                username: true,
                name: true,
                kind: true,
                avatarUpdatedAt: true,
                agent: { select: { slug: true, name: true, avatar: true } },
              },
            },
            steps: {
              orderBy: { rank: "asc" },
              select: {
                id: true,
                stepId: true,
                title: true,
                acceptanceCriteria: true,
                kind: true,
                rank: true,
                assignee: {
                  select: {
                    id: true,
                    username: true,
                    name: true,
                    kind: true,
                    avatarUpdatedAt: true,
                    agent: { select: { slug: true, name: true, avatar: true } },
                  },
                },
              },
            },
          },
        },
        blockedBy: { select: { id: true, workItemKey: true, title: true, status: true } },
        dependencies: {
          orderBy: { createdAt: "asc" },
          select: {
            prerequisite: {
              select: {
                id: true,
                workItemKey: true,
                title: true,
                status: true,
                projectId: true,
                private: true,
                project: { select: { slug: true, name: true } },
              },
            },
          },
        },
        // ENV-123 — the operator-visible execution strip. Nullable: a task that
        // has never been evaluated by the watchdog has no row, and the page
        // renders nothing rather than guessing a state.
        executionState: {
          select: {
            state: true,
            reasonCode: true,
            reasonDetail: true,
            lastDurableAction: true,
            lastDurableActionAt: true,
            recoveryAction: true,
            recoveryAt: true,
            detectorId: true,
            escalatedAt: true,
            updatedAt: true,
          },
        },
        repositoryRun: {
          select: {
            phase: true,
            validationOutcome: true,
            candidateSha: true,
            reviewedSha: true,
            lastError: true,
            updatedAt: true,
          },
        },
      },
    }),
    ["task-detail-shell", taskId],
    {
      tags: [taskCacheTag.shell(taskId)],
      revalidate: TASK_SHELL_CACHE_REVALIDATE_SECONDS,
    },
  )();
}

export function getCachedTaskComments(taskId: string) {
  return db.comment.findMany({
    where: { taskId },
    // Soft-deleted comments are returned to humans on the task page so
    // they can render the collapsed dotted divider. Agent context queries
    // filter deletedAt: null upstream so agents never see deleted bodies.
    select: {
      id: true,
      body: true,
      createdAt: true,
      deletedAt: true,
      deletedById: true,
      userId: true,
      authorAgentSlug: true,
      provider: true,
      model: true,
      commentKind: true,
      isGenerated: true,
      user: {
        select: {
          id: true,
          username: true,
          kind: true,
          name: true,
          avatarUpdatedAt: true,
          agent: { select: { slug: true, name: true, avatar: true } },
        },
      },
      deletedBy: {
        select: {
          id: true,
          username: true,
          name: true,
          kind: true,
        },
      },
    },
  }).then(sortByCreatedAtAsc);
}

export function getCachedTaskAttachments(taskId: string) {
  return unstable_cache(
    async () => db.attachment.findMany({
      where: { taskId },
      orderBy: { createdAt: "desc" },
      include: { uploader: { select: { username: true, kind: true } } },
    }),
    ["task-attachments", taskId],
    { tags: [taskCacheTag.attachments(taskId)] },
  )();
}

export function getCachedProjectEpics(projectId: string) {
  return unstable_cache(
    async () => db.epic.findMany({
      where: {
        projectId,
        archivedAt: null,
        deletedAt: null,
      },
      orderBy: [{ status: "asc" }, { title: "asc" }],
      select: { id: true, title: true, status: true, private: true },
    }),
    ["project-epics", projectId],
    { tags: [taskCacheTag.projectEpics(projectId)] },
  )();
}

export function getCachedRecentTaskChatMessages(taskId: string) {
  return unstable_cache(
    async () => db.agentChatMessage.findMany({
      where: { taskId, archiveId: null },
      orderBy: { createdAt: "desc" },
      take: 80,
      select: {
        id: true,
        agentSlug: true,
        originChannel: true,
        originCommentId: true,
        createdAt: true,
        body: true,
        sender: { select: { kind: true } },
      },
    }),
    ["task-recent-chat", taskId],
    { tags: [taskCacheTag.chat(taskId)] },
  )();
}

export function getCachedTaskActivity(taskId: string) {
  return unstable_cache(
    async () => db.activityLog.findMany({
      where: {
        taskId,
        kind: {
          in: [
            "task.chat.reply",
            "task.chat.silent",
            "task.chat.dispatch",
            "task.comment",
            "task.comment.silent",
            "task.chat.dispatch_failed",
            "task.comment.dispatch_failed",
            "task.workflow.dispatch_failed",
            "task.chat.stream_error",
          ],
        },
      },
      orderBy: { createdAt: "desc" },
      take: 160,
      select: { kind: true, payload: true, targetAgent: true },
    }),
    ["task-activity", taskId],
    { tags: [taskCacheTag.activity(taskId)] },
  )();
}

export function getCachedLatestRepoVerifyActivity(taskId: string) {
  return db.activityLog.findMany({
    where: {
      taskId,
      kind: {
        in: [
          "pm.repo.verify.ok",
          "pm.repo.verify.warning",
          "pm.repo.verify.fail",
          "pm.repo.verify.operational_error",
          "pm.repo.verify.enqueue",
        ],
      },
    },
    select: { kind: true, payload: true, createdAt: true },
  }).then(selectLatestRepoVerifyActivity);
}

export function selectLatestRepoVerifyActivity<T extends RepoVerifyActivityRow>(rows: T[]): T | null {
  let latest: T | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    const rowMs = createdAtMs(row.createdAt);
    if (rowMs > latestMs) {
      latest = row;
      latestMs = rowMs;
    }
  }
  return latest;
}

export function sortByCreatedAtAsc<T extends CreatedAtRow>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const delta = createdAtMs(a.createdAt) - createdAtMs(b.createdAt);
    if (delta !== 0) return delta;
    return (a.id ?? "").localeCompare(b.id ?? "");
  });
}

export function createdAtMs(createdAt: CreatedAtRow["createdAt"]): number {
  if (createdAt instanceof Date) return createdAt.getTime();
  if (typeof createdAt === "number") return Number.isFinite(createdAt) ? createdAt : Number.NEGATIVE_INFINITY;
  if (typeof createdAt === "bigint") return Number(createdAt);
  if (typeof createdAt === "string") {
    const numeric = Number(createdAt);
    if (Number.isFinite(numeric)) return numeric;
    const parsed = Date.parse(createdAt);
    return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
  }
  return Number.NEGATIVE_INFINITY;
}

export function getCachedTaskRoomMessages(taskId: string) {
  return unstable_cache(
    async () => db.agentChatMessage.findMany({
      where: {
        taskId,
        agentSlug: "room",
        archiveId: null,
      },
      // Soft-deleted bubbles stay in this list so the chat room can render
      // the collapsed dotted divider. Agent context queries filter them out.
      orderBy: { createdAt: "asc" },
      include: {
        sender: {
          select: {
            id: true,
            username: true,
            kind: true,
            name: true,
            avatarUpdatedAt: true,
            agent: { select: { slug: true, name: true, avatar: true } },
          },
        },
        deletedBy: { select: { username: true, name: true, kind: true } },
      },
    }),
    ["task-room-messages", taskId],
    { tags: [taskCacheTag.chat(taskId)] },
  )();
}

export function getCachedTaskChatArchives(projectId: string, taskId: string) {
  return unstable_cache(
    async () => Promise.all([
      db.agentChatRoomArchive.findMany({
        where: { projectId, taskId, deletedAt: null },
        orderBy: { createdAt: "desc" },
        take: 20,
        select: {
          id: true,
          summary: true,
          startedAt: true,
          endedAt: true,
          messageCount: true,
        },
      }),
      db.agentChatRoomArchive.findMany({
        where: { projectId, taskId, deletedAt: { not: null } },
        orderBy: { deletedAt: "desc" },
        take: 20,
        select: {
          id: true,
          summary: true,
          startedAt: true,
          endedAt: true,
          messageCount: true,
          deletedAt: true,
        },
      }),
    ]),
    ["task-chat-archives", projectId, taskId],
    { tags: [taskCacheTag.chatArchives(taskId)] },
  )();
}

export function getCachedPendingTaskProposals(taskId: string, projectId: string, messageIds: string[]) {
  return unstable_cache(
    async () => db.workItemProposal.findMany({
      where: {
        status: "pending",
        projectId,
        grantMessageId: { in: messageIds },
      },
      include: {
        project: { select: { name: true } },
      },
    }),
    ["task-pending-proposals", taskId, projectId, ...[...messageIds].sort()],
    { tags: [taskCacheTag.proposals(taskId)] },
  )();
}
