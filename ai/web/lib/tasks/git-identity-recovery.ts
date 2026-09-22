import { db } from "@/lib/db";
import { resolveGitIdentity } from "@/lib/settings/system";
import { activeFormalBlockerStatesByTask } from "@/lib/tasks/formal-blocker";
import { hasCompleteGitIdentity, isGitIdentityBlocker } from "@/lib/tasks/git-identity";
import { projectUsesRepository } from "@/lib/projects/work-mode";
import { enqueueWorkflowEffects } from "@/lib/tasks/transition-kernel";

/** Poll current configuration, including inherited defaults. No blocker is
 * cleared automatically: one durable, scoped wake asks the worker to verify
 * the repair and continue through the existing workflow. */
export async function recoverGitIdentityBlockers(options: { projectId?: string; take?: number; maxRepairs?: number } = {}) {
  const tasks = await db.task.findMany({
    where: {
      projectId: options.projectId, deletedAt: null, archivedAt: null,
      status: { in: ["To Do", "In Progress"] }, alertReporter: true,
      assignee: { kind: "agent", status: "active", agent: { is: { deactivatedAt: null } } },
      project: { deletedAt: null },
    },
    select: {
      id: true, projectId: true, assigneeId: true, reporterId: true,
      project: { select: { id: true, workMode: true, repositoryPath: true, defaultGitUserName: true, defaultGitUserEmail: true } },
    },
    orderBy: { id: "asc" }, take: options.take ?? 500,
  });
  if (!tasks.length) return 0;
  const rows = await db.activityLog.findMany({
    where: { taskId: { in: tasks.map((task) => task.id) }, kind: { in: ["task.blocker", "task.extra_work.blocker", "task.blocker.cleared", "task.blocker.permission.granted"] } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { taskId: true, kind: true, payload: true, createdAt: true },
  });
  const blockers = activeFormalBlockerStatesByTask(rows);
  let queued = 0;
  for (const task of tasks) {
    const blocker = blockers.get(task.id);
    if (queued >= (options.maxRepairs ?? 20)) break;
    if (!task.assigneeId || !projectUsesRepository(task.project) ||
        !blocker?.commentId || blocker.override || blocker.permissionRequest || !isGitIdentityBlocker(blocker.report)) continue;
    const identity = await resolveGitIdentity(task.project);
    if (!hasCompleteGitIdentity(identity)) continue;
    // One recovery per blocker and assignee, regardless of subsequent saves.
    const key = `git-identity-repaired:${blocker.commentId}:${task.assigneeId}`;
    const dedupeKey = `${task.id}:v0:${key}`;
    if (await db.workflowOutbox.findUnique({ where: { dedupeKey }, select: { id: true } })) continue;
    await enqueueWorkflowEffects(db, {
      taskId: task.id, projectId: task.projectId, aggregateVersion: 0,
      effects: [{ type: "task_notification", key, payload: {
        taskId: task.id, targetUserId: task.assigneeId,
        actor: { id: task.assigneeId, kind: "agent" }, reason: "blocker_response",
        body: [
          `PM verified that the effective Git identity is now complete (${identity.name} <${identity.email}>).`,
          `Configuration recovery for blocker ${blocker.commentId}. Check the current task and blocker before acting.`,
          "If this is still the only blocker, clear it through the task workflow and resume the approved plan from the existing worktree/checkpoint. If the work is already complete, submit it for review once.",
          "Do not repeat successful builds or change local git config solely because the PM configuration was repaired. Preserve any newer blocker or human instruction. Keep public comments concise.",
        ].join("\n"),
      } }],
    });
    queued += 1;
  }
  return queued;
}

