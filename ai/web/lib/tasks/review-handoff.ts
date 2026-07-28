// Shared Review-entry side effects (2026-07 workflow overhaul, P5).
//
// A task entering Review must trigger the SAME pipeline no matter who moved
// it — the assignee's workflow `ready_for_review` action or a human dragging
// the card on any board:
//
//   1. monitor branch-verify enqueue for code-touching work (with the
//      epicChild/epicBranch fields the local-only verifier mode consumes),
//   2. reviewer wake — verify-gated for code work (the pm.repo.verify.*
//      result is the reviewer's gate), immediate for non-code work,
//   3. epic queue refill preferring the freed worker (the task's assignee)
//      so nobody idles while the reviewer looks at finished work.
//
// Human board drags used to skip all three (the reviewer was told to wait for
// a verify result that never came); every board-move handler now calls this.

import { randomUUID } from "crypto";
import { db } from "@/lib/db";
import { sendTaskWorkflowNotification } from "@/lib/agents/workflow/notifications/task";
import { enqueueBranchVerifyJob, type BranchVerifyJob } from "@/lib/deploy/branch-verify";
import { refillEpicQueue } from "@/lib/epics/queue";
import { resolveEffectiveProjectSettings } from "@/lib/settings/effective";
import { effectiveTaskCommitPrefix } from "@/lib/work-items/keys";
import { effectiveEpicBranchName, effectiveTaskBranchName } from "@/lib/work-items/branches";
import { isProtectedBranch } from "@/lib/projects/protected-branches";
import { resolveReviewOwnerId } from "@/lib/tasks/workflow-actors";
import { revalidateTaskShell } from "@/lib/tasks/cache";

type Actor = {
  id: string;
  kind: "human" | "agent";
  username?: string | null;
};

export type ReviewHandoffResult = {
  verifyJobId: string | null;
  repoTouched: boolean;
  branchName: string | null;
  // Tasks handed out by the epic-queue refill; callers revalidate their own
  // route paths for these (shells are already revalidated here).
  refillAssignments: Array<{ taskId: string }>;
};

export async function runTaskReviewHandoff(args: {
  taskId: string;
  actor: Actor;
  via: string;
  // Status the task held BEFORE entering Review. The refill only runs when
  // the move actually freed a worker (i.e. the task was not already Review).
  movedFromStatus: string;
  // Explicit assignee declaration from ready_for_review; defaults to "code-
  // touching iff an effective branch and repositoryPath resolve".
  repoTouched?: boolean;
  // Optional assignee note forwarded to the reviewer on immediate wakes.
  assigneeNote?: string | null;
}): Promise<ReviewHandoffResult> {
  const task = await db.task.findUnique({
    where: { id: args.taskId },
    select: {
      id: true,
      title: true,
      projectId: true,
      epicId: true,
      assigneeId: true,
      actingManagerId: true,
      reporterId: true,
      branchName: true,
      commitPrefix: true,
      workItemKey: true,
      assignee: {
        select: { agent: { select: { slug: true } } },
      },
      project: {
        select: {
          slug: true,
          repositoryPath: true,
          defaultGitUserName: true,
          defaultGitUserEmail: true,
          deploymentProductionBranch: true,
          deploymentPrTargetBranch: true,
          agentChangeBlockedBranches: true,
        },
      },
      epic: { select: { status: true, actingManagerId: true, branchName: true, workItemKey: true, commitPrefix: true } },
    },
  });
  if (!task) return { verifyJobId: null, repoTouched: false, branchName: null, refillAssignments: [] };

  const branchName = effectiveTaskBranchName(task);
  const codeTouching = Boolean(branchName && task.project.repositoryPath);
  const repoTouched = typeof args.repoTouched === "boolean" ? args.repoTouched : codeTouching;
  const protectedBranch = Boolean(
    repoTouched && isProtectedBranch(task.project.agentChangeBlockedBranches, branchName),
  );

  // 1. Monitor verifier: only enqueue when the task plausibly touched the
  // repo. No effective branch / repositoryPath, an explicit repoTouched=false
  // (doc-only work), or a protected branch (nothing an agent may verify or
  // push there) → skip; the reviewer is woken directly instead.
  let verifyJobId: string | null = null;
  if (repoTouched && branchName && task.project.repositoryPath && !protectedBranch) {
    const jobId = randomUUID();
    const effectiveSettings = await resolveEffectiveProjectSettings({
      id: task.projectId,
      defaultGitUserName: task.project.defaultGitUserName,
      defaultGitUserEmail: task.project.defaultGitUserEmail,
      deploymentProductionBranch: task.project.deploymentProductionBranch,
      deploymentPrTargetBranch: task.project.deploymentPrTargetBranch,
    });
    const gitIdentity = {
      name: effectiveSettings.gitIdentity.name.value,
      email: effectiveSettings.gitIdentity.email.value,
    };
    const baseBranch = effectiveSettings.deployment.prTargetBranch.value;
    const resolvedCommitPrefix = effectiveTaskCommitPrefix(task);
    // Epic children live on LOCAL-ONLY branches (P6): the verifier checks
    // refs/heads/<branch> against the epic integration branch instead of
    // origin/<base>. WP2's verifier consumes these exact field names.
    const job: BranchVerifyJob & { epicChild: boolean; epicBranch: string | null } = {
      jobId,
      taskId: task.id,
      projectId: task.projectId,
      projectSlug: task.project.slug,
      repositoryPath: task.project.repositoryPath!,
      branchName: branchName!,
      baseBranch,
      commitPrefix: resolvedCommitPrefix,
      expectedGitUserName: gitIdentity.name,
      expectedGitUserEmail: gitIdentity.email,
      requestedByAgentSlug: task.assignee?.agent?.slug ?? args.actor.username ?? "human",
      requestedByUserId: args.actor.id,
      requestedAt: new Date().toISOString(),
      epicChild: Boolean(task.epicId),
      epicBranch: task.epic ? effectiveEpicBranchName(task.epic) : null,
    };
    try {
      await enqueueBranchVerifyJob(job);
      verifyJobId = jobId;
      await db.activityLog.create({
        data: {
          projectId: task.projectId,
          taskId: task.id,
          userId: args.actor.id,
          kind: "pm.repo.verify.enqueue",
          targetAgent: task.assignee?.agent?.slug ?? null,
          payload: JSON.stringify({
            jobId,
            branchName,
            baseBranch,
            commitPrefix: resolvedCommitPrefix,
            repositoryPath: task.project.repositoryPath,
            expectedGitUserName: gitIdentity.name,
            expectedGitUserEmail: gitIdentity.email,
            epicChild: job.epicChild,
            epicBranch: job.epicBranch,
            via: args.via,
          }),
        },
      });
    } catch (err) {
      // Enqueue failure is non-fatal to the Review transition, but it must
      // not wake the reviewer for code work as if verified. The reviewer is
      // woken below with an explicit workflow/setup warning instead.
      console.warn(`[review-handoff] failed to enqueue branch verify for ${task.id}`, err);
    }
  }

  // 2. Reviewer wake. Code work with a queued verify job is verify-gated:
  // the runner wakes the reviewer once pm.repo.verify.* lands. Everything
  // else (non-code work, enqueue failure, protected branch) wakes now.
  const reviewerId = resolveReviewOwnerId({
    actingManagerId: task.actingManagerId,
    reporterId: task.reporterId,
    epic: task.epic ? { status: task.epic.status, actingManagerId: task.epic.actingManagerId } : null,
  });
  const reviewerShouldWaitForMonitor = repoTouched && Boolean(verifyJobId);
  if (reviewerId && !reviewerShouldWaitForMonitor) {
    await sendTaskWorkflowNotification({
      taskId: task.id,
      targetUserId: reviewerId,
      actor: args.actor,
      reason: "review_requested",
      body: [
        `Task "${task.title}" was moved to Review${args.actor.username ? ` by @${args.actor.username}` : ""}.`,
        args.assigneeNote ? `Assignee note:\n${args.assigneeNote}` : null,
        repoTouched
          ? protectedBranch
            ? `This task's effective branch (${branchName}) is a protected branch, so no monitor verification was queued. Treat this as a workflow/setup issue before approving code work.`
            : "No monitor branch verification could be queued, so treat this as a workflow/setup issue before approving code work."
          : "This task did not change the repository (or no branch is set). Verify the non-code work directly.",
        "BEFORE reviewing: add the topics you will address as review sub-tasks (action=add_subtask with subtaskKind:\"review\", one per topic), then mark each complete (action=complete_subtask) as you address it — the board shows your review progress from these.",
        "Review the completed work or respond to the assignee's blocker/question using the full task context. If satisfied, move the task to Done through the workflow endpoint without posting an approval-only comment. If changes or blockers remain, call action=review_feedback with one consolidated comment — PM returns the task to the FRONT of To Do for the assignee.",
      ].filter(Boolean).join("\n"),
    });
  }

  // 3. Queue refill (P5): a task entering Review frees its worker (Review
  // never counts toward the per-agent WIP limit) — hand the freed assignee
  // the epic's next unblocked To Do task immediately.
  const refillAssignments: Array<{ taskId: string }> = [];
  if (task.epicId && args.movedFromStatus !== "Review") {
    const refill = await refillEpicQueue({
      epicId: task.epicId,
      actor: args.actor,
      via: args.via,
      preferUserId: task.assigneeId ?? undefined,
      contextLine: `"${task.title}" moved to Review — your review-stage feedback there stays priority one.`,
    });
    for (const assigned of refill.assignments) {
      revalidateTaskShell(assigned.task.id);
      refillAssignments.push({ taskId: assigned.task.id });
    }
  }

  return { verifyJobId, repoTouched, branchName, refillAssignments };
}
