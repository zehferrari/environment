import { revalidateTag, unstable_cache } from "next/cache";
import { db } from "@/lib/db";

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
        parent: { select: { id: true, title: true } },
        subtasks: {
          where: { deletedAt: null, archivedAt: null },
          orderBy: { rank: "asc" },
          select: {
            id: true,
            workItemKey: true,
            title: true,
            status: true,
            alertReporter: true,
            updatedAt: true,
            assignee: { select: { username: true } },
          },
        },
      },
    }),
    ["task-detail-shell", taskId],
    { tags: [taskCacheTag.shell(taskId)] },
  )();
}

export function getCachedTaskComments(taskId: string) {
  return db.comment.findMany({
    where: { taskId },
    // Soft-deleted comments are returned to humans on the task page so
    // they can render the collapsed dotted divider. Agent context queries
    // filter deletedAt: null upstream so agents never see deleted bodies.
    orderBy: { createdAt: "asc" },
    include: {
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
  });
}

export function getCachedTaskAttachments(taskId: string) {
  return unstable_cache(
    async () => db.attachment.findMany({
      where: { taskId },
      orderBy: { createdAt: "desc" },
      include: { uploader: { select: { username: true } } },
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
      select: { id: true, title: true, status: true },
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
  return db.activityLog.findFirst({
    where: {
      taskId,
      kind: { in: ["pm.repo.verify.ok", "pm.repo.verify.fail", "pm.repo.verify.enqueue"] },
    },
    orderBy: { createdAt: "desc" },
    select: { kind: true, payload: true, createdAt: true },
  });
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
