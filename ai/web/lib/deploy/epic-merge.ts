import { db } from "@/lib/db";
import { publishBoardTouch } from "@/lib/pm/board-events";
import { effectiveEpicBranchName, effectiveTaskBranchName } from "@/lib/work-items/branches";
import { sendTaskWorkflowNotification } from "@/lib/agents/workflow/notifications/task";
import { mergeTaskBranchIntoEpic } from "@/lib/deploy/epic-merge-git";

// Auto-merge a Done Epic-child task's branch into the Epic integration branch.
//
// EPICS ONLY: a standalone task (no epic parent) is never merged here — its
// branch lands on production directly and is picked up by merge-detect. This
// runs in-process on the deployment-watcher poll (same karen/monitor process
// that already does `git fetch` for merge detection), so it needs no new
// service. Each merge happens in an EPHEMERAL detached worktree so the shared
// checkout and any agent worktrees are never disturbed.
//
// Idempotency + retry: a successful (or no-op) merge records a
// `pm.epic.merge.ok` activity; the poll query excludes tasks that already have
// one, so each task is merged at most once. A merge conflict (or any git
// failure) bounces the task back to Review with a comment — once it leaves Done
// it drops out of the poll set, and re-completing it (after a rebase/fix)
// retries the merge.

// The production branch the Epic integration branch is cut from when it does
// not exist yet: project override -> first workspace default -> "main".
async function productionBranchFor(projectId: string): Promise<string> {
  const project = await db.project.findUnique({
    where: { id: projectId },
    select: {
      deploymentProductionBranch: true,
      workspaces: {
        orderBy: { createdAt: "asc" },
        take: 1,
        select: { workspace: { select: { deploymentProductionBranch: true } } },
      },
    },
  });
  return (
    project?.deploymentProductionBranch?.trim() ||
    project?.workspaces[0]?.workspace.deploymentProductionBranch?.trim() ||
    "main"
  );
}

// The agent user that authors the merge-failure comment / bounce: the Epic's
// Deploy Reviewer when it is an active agent, else the monitor agent.
async function resolveEpicMergeActor(
  deployReviewerId: string | null,
): Promise<{ id: string; username: string } | null> {
  if (deployReviewerId) {
    const reviewer = await db.user.findFirst({
      where: {
        id: deployReviewerId,
        status: "active",
        kind: "agent",
        agent: { is: { deactivatedAt: null } },
      },
      select: { id: true, username: true },
    });
    if (reviewer) return reviewer;
  }
  const monitor = await db.agent.findFirst({
    where: { role: "monitor", deactivatedAt: null, user: { is: { status: "active" } } },
    orderBy: { createdAt: "asc" },
    select: { user: { select: { id: true, username: true } } },
  });
  return monitor?.user ?? null;
}

type MergeCandidate = {
  id: string;
  title: string;
  projectId: string;
  workItemKey: string | null;
  branchName: string | null;
  assigneeId: string | null;
  project: {
    slug: string;
    repositoryPath: string | null;
    defaultGitUserName: string | null;
    defaultGitUserEmail: string | null;
  };
  epic: {
    id: string;
    status: string;
    workItemKey: string | null;
    branchName: string | null;
    deployReviewerId: string | null;
  } | null;
};

async function recordMergeOk(task: MergeCandidate, epicBranch: string, detail: Record<string, unknown>) {
  await db.activityLog.create({
    data: {
      projectId: task.projectId,
      taskId: task.id,
      kind: "pm.epic.merge.ok",
      payload: JSON.stringify({ taskId: task.id, epicId: task.epic?.id, epicBranch, ...detail }),
    },
  });
  publishBoardTouch(task.projectId);
}

async function bounceTaskToReview(args: {
  task: MergeCandidate;
  epicBranch: string;
  taskBranch: string;
  reason: string;
}) {
  const { task, epicBranch, taskBranch, reason } = args;
  const actor = await resolveEpicMergeActor(task.epic?.deployReviewerId ?? null);
  const now = new Date();

  await db.$transaction(async (tx) => {
    const maxRank = await tx.task.aggregate({
      where: { status: "Review", archivedAt: null, deletedAt: null },
      _max: { rank: true },
    });
    await tx.task.update({
      where: { id: task.id },
      data: { status: "Review", rank: (maxRank._max.rank ?? 0) + 1, statusChangedAt: now },
    });
    await tx.activityLog.create({
      data: {
        projectId: task.projectId,
        taskId: task.id,
        userId: actor?.id ?? null,
        kind: "task.move",
        payload: JSON.stringify({ from: "Done", to: "Review", via: "epic_merge_failed", epicBranch, taskBranch }),
      },
    });

    // A prematurely-Done Epic (rolled to Done by this being its last child) must
    // step back to In Progress now that a child has returned to Review.
    if (task.epic && task.epic.status === "Done") {
      await tx.epic.update({
        where: { id: task.epic.id },
        data: { status: "In Progress", statusChangedAt: now },
      });
      await tx.activityLog.create({
        data: {
          projectId: task.projectId,
          userId: actor?.id ?? null,
          kind: "epic.status",
          payload: JSON.stringify({ epicId: task.epic.id, from: "Done", to: "In Progress", via: "epic_merge_failed" }),
        },
      });
    }

    if (actor) {
      const comment = await tx.comment.create({
        data: {
          taskId: task.id,
          userId: actor.id,
          body: `🔀 Auto-merge into the Epic branch \`${epicBranch}\` failed, so this task is back in Review.\n\n${reason}`,
        },
        select: { id: true },
      });
      await tx.activityLog.create({
        data: {
          projectId: task.projectId,
          taskId: task.id,
          userId: actor.id,
          kind: "task.comment",
          payload: JSON.stringify({ commentId: comment.id, reason: "epic_merge_failed" }),
        },
      });
    }

    await tx.activityLog.create({
      data: {
        projectId: task.projectId,
        taskId: task.id,
        userId: actor?.id ?? null,
        kind: "pm.epic.merge.fail",
        payload: JSON.stringify({ taskId: task.id, epicId: task.epic?.id, epicBranch, taskBranch, reason }),
      },
    });
  });

  if (task.assigneeId && actor) {
    await sendTaskWorkflowNotification({
      taskId: task.id,
      targetUserId: task.assigneeId,
      actor: { id: actor.id, username: actor.username, kind: "agent" },
      reason: "review_feedback",
      body: [
        `Your task "${task.title}" could not be auto-merged into the Epic branch \`${epicBranch}\` and is back in Review.`,
        reason,
        "Resolve it, push your branch, then move the task to Done again to retry the integration.",
      ].join("\n"),
    }).catch((err) => console.error("[pm] epic merge bounce notify failed:", task.id, err));
  }

  publishBoardTouch(task.projectId);
}

// Deployment-watcher poll step: integrate every Done Epic-child task whose
// branch has not yet been merged into its Epic branch. Mirrors
// pollDeploymentMerges() — one fetch per repo, sequential per task so a shared
// Epic branch never races itself.
export async function pollEpicTaskMerges(): Promise<{ checked: number; merged: number; bounced: number }> {
  const tasks = (await db.task.findMany({
    where: {
      status: "Done",
      epicId: { not: null },
      parentTaskId: null,
      deletedAt: null,
      archivedAt: null,
      project: { repositoryPath: { not: null } },
      activity: { none: { kind: "pm.epic.merge.ok" } },
    },
    orderBy: { statusChangedAt: "asc" },
    take: 25,
    select: {
      id: true,
      title: true,
      projectId: true,
      workItemKey: true,
      branchName: true,
      assigneeId: true,
      project: {
        select: {
          slug: true,
          repositoryPath: true,
          defaultGitUserName: true,
          defaultGitUserEmail: true,
        },
      },
      epic: {
        select: {
          id: true,
          status: true,
          workItemKey: true,
          branchName: true,
          deployReviewerId: true,
        },
      },
    },
  })) as MergeCandidate[];

  let checked = 0;
  let merged = 0;
  let bounced = 0;

  for (const task of tasks) {
    const repoPath = task.project.repositoryPath;
    const epicBranch = task.epic ? effectiveEpicBranchName(task.epic) : null;
    const taskBranch = effectiveTaskBranchName({
      workItemKey: task.workItemKey,
      branchName: task.branchName,
      epic: task.epic,
    });
    if (!repoPath || !epicBranch || !taskBranch) {
      // Nothing actionable (e.g. no derivable branch) — mark done so we stop
      // re-scanning it every tick.
      await recordMergeOk(task, epicBranch ?? "", { note: "no derivable branch" });
      continue;
    }

    checked++;
    try {
      const baseBranch = await productionBranchFor(task.projectId);
      const result = await mergeTaskBranchIntoEpic({
        repoPath,
        epicBranch,
        taskBranch,
        baseBranch,
        gitUserName: task.project.defaultGitUserName?.trim() || "PM Monitor",
        gitUserEmail: task.project.defaultGitUserEmail?.trim() || "pm-monitor@localhost",
        message: `Merge ${task.workItemKey ?? taskBranch} into Epic branch ${epicBranch}`,
      });
      if (result.ok) {
        await recordMergeOk(task, epicBranch, {
          taskBranch,
          kind: result.kind,
          ...(result.kind === "merged" ? { sha: result.sha } : {}),
          ...(result.kind === "noop" ? { note: result.note } : {}),
        });
        if (result.kind === "merged") merged++;
      } else {
        await bounceTaskToReview({ task, epicBranch, taskBranch, reason: result.reason });
        bounced++;
      }
    } catch (err) {
      console.error("[pm] epic merge failed:", task.id, err);
    }
  }

  return { checked, merged, bounced };
}
