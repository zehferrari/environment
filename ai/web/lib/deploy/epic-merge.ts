import { isReviewerCheckpointAuthorization } from "@/lib/tasks/reviewer-checkpoint-authorization";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { isActiveOwnerPrincipal } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import { publishBoardTouch } from "@/lib/pm/board-events";
import { effectiveEpicBranchName, effectiveTaskBranchName } from "@/lib/work-items/branches";
import { sendTaskWorkflowNotification } from "@/lib/agents/workflow/notifications/task";
import {
  inspectOriginBranch,
  inspectValidatedCandidateWorktree,
  mergeTaskBranchIntoEpic,
  publishTaskCheckpointToEpic,
  publishStandaloneTaskCheckpoint,
  publishEpicBranch,
  removeMergedOriginChildBranch,
} from "@/lib/deploy/epic-merge-git";
import {
  recordTaskReviewOperationalError,
} from "@/lib/tasks/review-handoff";
import {
  resolveActiveMonitorAgent,
  updateTaskRepositoryState,
} from "@/lib/tasks/repository-state";
import { isOperationalRepositoryFailure } from "@/lib/tasks/repository-validation";
import { effectiveTaskCommitPrefix } from "@/lib/work-items/keys";
import { resolveEffectiveProjectSettings } from "@/lib/settings/effective";
import { isProtectedBranch } from "@/lib/projects/protected-branches";
import {
  activityPayloadUsesCheckpointAuthorization,
  validateCheckpointAuthorizationText,
} from "@/lib/deploy/checkpoint-authorization";
import { settleConsumedCheckpointBlocker } from "@/lib/tasks/checkpoint-blocker";
import { submitEpicChildUpdateInTransaction } from "@/lib/epics/task-workflow-adapter";
import {
  ENGINE_ORCHESTRATOR_V2,
  resolveEngineOwnership,
} from "@/lib/tasks/orchestrator/ownership";
import {
  enqueueWorkflowEffects,
} from "@/lib/tasks/transition-kernel";
import { drainWorkflowOutbox } from "@/lib/tasks/workflow-outbox-drain";
import { purgeTaskHardResetState } from "@/lib/tasks/hard-reset";
import { localWorktreeProtectedBranches } from "@/lib/deploy/local-worktree";
import { withDevPublication, publicationAttemptId, DevPublicationError, assertDevPublicationCandidate, releaseTaskDevLease } from "@/lib/deploy/dev-publication";
import { validateStandingAuthorization } from "@/lib/tasks/standing-authorization";
import { queueTaskExecutionContinuation } from "@/lib/agents/pm-channel/continuations";
import { assertEpicReleaseChecksComplete } from "@/lib/tasks/acceptance";

async function publishWithDevLease<T extends { ok: boolean }>(args: {
  projectId: string; taskId?: string; branch: string; repositoryPath: string; attemptId: string; grantId?: string;
  publish: (beforePush: (sha: string) => Promise<void>) => Promise<T>;
}): Promise<T | { ok: false; reason: string; deferred?: boolean }> {
  try {
    return await withDevPublication({ ...args, publish: () => args.publish(async sha => {
      if (args.grantId && args.taskId) {
        const authority = await validateStandingAuthorization(db, { taskId: args.taskId, grantId: args.grantId });
        if (!authority.ok) throw new DevPublicationError(authority.reason);
      }
      await assertDevPublicationCandidate({ projectId: args.projectId, repositoryPath: args.repositoryPath, branch: args.branch, sha });
    }), publishedSha: async result => {
      if (!result.ok) return null;
      const remote = await inspectOriginBranch(args.repositoryPath, args.branch);
      const candidate = result as T & { publishedSha?: string; epicSha?: string; sha?: string };
      const expected = candidate.publishedSha ?? candidate.epicSha ?? candidate.sha;
      if (expected && (!remote.ok || remote.sha !== expected)) throw new DevPublicationError("Origin advanced before Dev verification; the exact published candidate is no longer confirmed.", true);
      return remote.ok ? remote.sha : null;
    } });
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "Dev publication could not settle.", deferred: error instanceof DevPublicationError && error.retryable };
  }
}

// Auto-merge a Done Epic-child task's branch into the Epic integration branch.
//
// EPICS ONLY: a standalone task (no epic parent) is never merged here — its
// branch lands on production directly and is picked up by merge-detect.
//
// Split execution model: pm.service runs inside a systemd sandbox
// (ProtectSystem=strict, no repo in ReadWritePaths) that blocks `git worktree
// add`, fetch ref-writes, and push/SSH — so the poll below only SELECTS
// candidates and ENQUEUES spool jobs. The unsandboxed pm-epic-merge-runner
// (same pattern as pm-verify-runner) picks each job up and calls
// runEpicMergeSpoolJob() via scripts/pm-epic-merge-job.ts, which does the git
// work and the DB bookkeeping (merge.ok record / Review bounce / cleanup).
//
// Idempotency + retry: a successful (or no-op) merge records a
// `pm.epic.merge.ok` activity; the poll query excludes tasks that already have
// one, and the spool uses one deterministic file per task, so each task is
// merged at most once. A merge conflict (or any git failure) bounces the task
// back to Review with a comment — once it leaves Done it drops out of the poll
// set, and re-completing it (after a local fix) retries the merge.

export const EPIC_MERGE_DIR = process.env.PM_EPIC_MERGE_DIR ?? "/var/lib/pm/epic-merge";

export type EpicMergeJob =
  | {
      kind: "merge";
      jobId: string;
      taskId: string;
      projectId: string;
      // Only Epic-Done finalization may merge a child archived by the same
      // human Done transition. The background poll never opts into this.
      includeArchived?: boolean;
      enqueuedAt: string;
    }
  | {
      kind: "cleanup";
      jobId: string;
      epicId: string;
      projectId: string;
      repositoryPath: string;
      epicBranch: string;
      branches: string[];
      enqueuedAt: string;
    }
  | {
      kind: "finalize";
      jobId: string;
      taskId: string;
      projectId: string;
      requestedByUserId: string;
      requestedByUsername: string;
      candidateSha: string;
      // PHASEE-07: schema version for exact callback correlation.
      schemaVersion?: number;
      procedureRunId?: string;
      procedureStepId?: string;
      workflowCycleId?: string | null;
      // PHASEE-07: additional V2 identity fields for exact correlation.
      commandReceiptId?: string | null;
      repositoryRunId?: string | null;
      repositoryRunVersion?: number | null;
      baseSha?: string | null;
      attempt?: number;
      enqueuedAt: string;
    }
  | {
      kind: "checkpoint";
      jobId: string;
      taskId: string;
      projectId: string;
      requestedByUserId: string;
      requestedByUsername: string;
      authorizationCommentId: string;
      standingAuthorizationId?: string;
      publicationAttemptId?: string;
      note: string;
      enqueuedAt: string;
    }
  | {
      kind: "review";
      jobId: string;
      epicId: string;
      projectId: string;
      enqueuedAt: string;
    }
  | {
      kind: "review-approval";
      jobId: string;
      epicId: string;
      projectId: string;
      requestedByUserId: string;
      requestedByUsername: string;
      expectedCandidateSha: string | null;
      enqueuedAt: string;
    }
  | {
      kind: "reset";
      jobId: string;
      taskId: string;
      projectId: string;
      requestedByUserId: string;
      requestedByUsername: string;
      resetToken: string;
      repositoryPath: string | null;
      branchName: string | null;
      stoppedAgents: string[];
      enqueuedAt: string;
    };

// One deterministic spool filename per subject so a 60s poll tick can never
// stack duplicate jobs while the runner is busy. `.running`/`.failed` suffixes
// are runner claim states (see deploy/pm-epic-merge-runner).
function jobFileName(job: EpicMergeJob) {
  if (job.kind === "merge") return `merge-${job.taskId}.json`;
  if (job.kind === "finalize") return `finalize-${job.taskId}-${job.candidateSha.slice(0, 16)}.json`;
  if (job.kind === "checkpoint") return job.standingAuthorizationId ? `${job.jobId}.json` : `checkpoint-${job.taskId}.json`;
  if (job.kind === "reset") return `reset-${job.taskId}.json`;
  if (job.kind === "review") return `review-${job.epicId}.json`;
  if (job.kind === "review-approval") return `review-approval-${job.epicId}.json`;
  return `cleanup-${job.epicId}.json`;
}

export function taskHardResetJobState(taskId: string) {
  const target = path.join(EPIC_MERGE_DIR, `reset-${taskId}.json`);
  if (existsSync(`${target}.running`)) return "running" as const;
  if (existsSync(target)) return "queued" as const;
  if (existsSync(`${target}.failed`)) return "failed" as const;
  return "absent" as const;
}

export async function enqueueTaskHardReset(args: {
  taskId: string;
  projectId: string;
  requestedByUserId: string;
  requestedByUsername: string;
  resetToken: string;
  repositoryPath: string | null;
  branchName: string | null;
  stoppedAgents: string[];
}) {
  const job: Extract<EpicMergeJob, { kind: "reset" }> = {
    kind: "reset",
    jobId: `reset-${args.taskId}-${args.resetToken}`,
    taskId: args.taskId,
    projectId: args.projectId,
    requestedByUserId: args.requestedByUserId,
    requestedByUsername: args.requestedByUsername,
    resetToken: args.resetToken,
    repositoryPath: args.repositoryPath,
    branchName: args.branchName,
    stoppedAgents: args.stoppedAgents,
    enqueuedAt: new Date().toISOString(),
  };
  const target = path.join(EPIC_MERGE_DIR, jobFileName(job));
  if (existsSync(`${target}.failed`)) await unlink(`${target}.failed`);
  const spooledPath = await enqueueEpicMergeJob(job);
  return { enqueued: Boolean(spooledPath), jobId: job.jobId };
}

async function enqueueEpicMergeJob(
  job: EpicMergeJob,
  options: { allowWhileRunning?: boolean } = {},
): Promise<string | null> {
  await mkdir(EPIC_MERGE_DIR, { recursive: true, mode: 0o770 });
  const name = jobFileName(job);
  const target = path.join(EPIC_MERGE_DIR, name);
  if (
    existsSync(target) ||
    (!options.allowWhileRunning && existsSync(`${target}.running`)) ||
    existsSync(`${target}.failed`)
  ) {
    return null; // already queued / in flight / awaiting operator retry
  }
  // Atomic write (write tmp + rename) so the runner never reads a partial file.
  const tmp = path.join(EPIC_MERGE_DIR, `.${name}.tmp`);
  await writeFile(tmp, JSON.stringify(job, null, 2), { mode: 0o660 });
  await rename(tmp, target);
  return target;
}

export async function enqueueTaskReviewFinalization(args: {
  taskId: string;
  projectId: string;
  requestedByUserId: string;
  requestedByUsername: string;
  candidateSha: string;
  procedureRunId?: string;
  procedureStepId?: string;
  workflowCycleId?: string | null;
  // PHASEE-07: V2 identity fields for exact callback correlation.
  schemaVersion?: number;
  commandReceiptId?: string | null;
  repositoryRunId?: string | null;
  repositoryRunVersion?: number | null;
  baseSha?: string | null;
}) {
  const exactV2JobId = args.schemaVersion === 2 && args.procedureRunId && args.procedureStepId
    ? `proc-finalize-${args.procedureRunId}-${args.procedureStepId}`
    : null;
  const job: Extract<EpicMergeJob, { kind: "finalize" }> = {
    kind: "finalize",
    jobId: exactV2JobId ?? `finalize-${args.taskId}`,
    taskId: args.taskId,
    projectId: args.projectId,
    requestedByUserId: args.requestedByUserId,
    requestedByUsername: args.requestedByUsername,
    candidateSha: args.candidateSha,
    schemaVersion: args.schemaVersion,
    procedureRunId: args.procedureRunId,
    procedureStepId: args.procedureStepId,
    workflowCycleId: args.workflowCycleId,
    commandReceiptId: args.commandReceiptId,
    repositoryRunId: args.repositoryRunId,
    repositoryRunVersion: args.repositoryRunVersion,
    baseSha: args.baseSha,
    enqueuedAt: new Date().toISOString(),
  };
  const target = path.join(EPIC_MERGE_DIR, jobFileName(job));
  const blockedByFailedJob = existsSync(`${target}.failed`);
  const spooledPath = await enqueueEpicMergeJob(job);
  return { enqueued: Boolean(spooledPath), blockedByFailedJob, jobId: job.jobId };
}

export async function enqueueTaskCheckpoint(args: {
  taskId: string;
  projectId: string;
  requestedByUserId: string;
  requestedByUsername: string;
  authorizationCommentId?: string;
  standingAuthorizationId?: string;
  publicationAttemptId?: string;
  note: string;
}) {
  if (args.standingAuthorizationId && !args.publicationAttemptId) throw new Error("Standing publication needs a stable per-attempt identity.");
  if (!args.standingAuthorizationId && !args.authorizationCommentId) throw new Error("Checkpoint publication requires explicit authorization.");
  const attempt = args.standingAuthorizationId ? publicationAttemptId(args.publicationAttemptId!) : null;
  const job: Extract<EpicMergeJob, { kind: "checkpoint" }> = {
    kind: "checkpoint",
    jobId: attempt ? `checkpoint-${args.taskId}-${attempt}` : `checkpoint-${args.taskId}`,
    taskId: args.taskId,
    projectId: args.projectId,
    requestedByUserId: args.requestedByUserId,
    requestedByUsername: args.requestedByUsername,
    authorizationCommentId: args.authorizationCommentId ?? `standing-${attempt}`,
    standingAuthorizationId: args.standingAuthorizationId,
    publicationAttemptId: args.publicationAttemptId,
    note: args.note,
    enqueuedAt: new Date().toISOString(),
  };
  const target = path.join(EPIC_MERGE_DIR, jobFileName(job));
  const blockedByFailedJob = existsSync(`${target}.failed`);
  const spooledPath = await enqueueEpicMergeJob(job);
  return { enqueued: Boolean(spooledPath), blockedByFailedJob, jobId: job.jobId };
}

export async function enqueueEpicCompletionReview(epicId: string) {
  const epic = await db.epic.findUnique({
    where: { id: epicId },
    select: { id: true, projectId: true, status: true, completionReviewStatus: true },
  });
  if (!epic || epic.status !== "Review" || epic.completionReviewStatus !== "Preparing") {
    return { enqueued: false, note: "Epic is not preparing for completion review" };
  }
  const job: Extract<EpicMergeJob, { kind: "review" }> = {
    kind: "review",
    jobId: `review-${epic.id}`,
    epicId: epic.id,
    projectId: epic.projectId,
    enqueuedAt: new Date().toISOString(),
  };
  const target = path.join(EPIC_MERGE_DIR, jobFileName(job));
  const blockedByFailedJob = existsSync(`${target}.failed`);
  const spooledPath = await enqueueEpicMergeJob(job);
  return { enqueued: Boolean(spooledPath), blockedByFailedJob, jobId: job.jobId };
}

export async function enqueueEpicCompletionReviewApproval(args: {
  epicId: string;
  projectId: string;
  requestedByUserId: string;
  requestedByUsername: string;
  expectedCandidateSha: string | null;
}) {
  const job: Extract<EpicMergeJob, { kind: "review-approval" }> = {
    kind: "review-approval",
    jobId: `review-approval-${args.epicId}`,
    epicId: args.epicId,
    projectId: args.projectId,
    requestedByUserId: args.requestedByUserId,
    requestedByUsername: args.requestedByUsername,
    expectedCandidateSha: args.expectedCandidateSha,
    enqueuedAt: new Date().toISOString(),
  };
  const target = path.join(EPIC_MERGE_DIR, jobFileName(job));
  const blockedByFailedJob = existsSync(`${target}.failed`);
  const spooledPath = await enqueueEpicMergeJob(job);
  return { enqueued: Boolean(spooledPath), blockedByFailedJob, jobId: job.jobId };
}

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

async function monitorAgentUser(): Promise<{ id: string; username: string } | null> {
  const monitor = await resolveActiveMonitorAgent();
  return monitor.ok ? monitor.user : null;
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
  return monitorAgentUser();
}

type MergeCandidate = {
  id: string;
  title: string;
  projectId: string;
  workItemKey: string | null;
  branchName: string | null;
  assigneeId: string | null;
  workflowVersion: number;
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

const MERGE_CANDIDATE_SELECT = {
  id: true,
  title: true,
  projectId: true,
  workItemKey: true,
  branchName: true,
  assigneeId: true,
  workflowVersion: true,
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
} as const;

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
  if (!actor) {
    throw new Error("epic_merge_actor_unavailable: no active deploy reviewer or monitor can authorize the repair callback");
  }
  const now = new Date();

  await db.$transaction(async (tx) => {
    await submitEpicChildUpdateInTransaction(tx, {
      taskId: task.id,
      workflowVersion: task.workflowVersion,
      actor: { id: actor.id, username: actor.username, kind: "agent", role: "operator" },
      source: "pm-service",
      idempotencyKey: `epic-merge-failed:${epicBranch}:${taskBranch}:v${task.workflowVersion + 1}`,
      payload: {
        epicId: task.epic!.id,
        targetStatus: "Review",
        reason: "epic_merge_failed",
        rank: "back",
        clearAssignee: false,
        clearArchive: true,
        archive: false,
        resetPlanApproval: false,
        comment: `🔀 Auto-merge into the Epic branch \`${epicBranch}\` failed, so this task is back in Review.\n\n${reason}`,
        notification: task.assigneeId
          ? {
              targetUserId: task.assigneeId,
              reason: "review_feedback",
              body: [
                `Your task "${task.title}" could not be auto-merged into the Epic branch \`${epicBranch}\` and is back in Review.`,
                reason,
                `Keep work on the registered \`${taskBranch}\` worktree. PM owns repository synchronization and commits; after conflict resolution and fresh validation, request independent review again.`,
              ].join("\n"),
            }
          : null,
      },
      evidence: { epicId: task.epic!.id, epicBranch, taskBranch, reason },
    });

    // A child integration failure invalidates any in-flight whole-Epic
    // candidate. Reopen the Epic for repair whether this is a legacy
    // prematurely-Done record or the normal Review-stage acceptance gate.
    if (task.epic && (task.epic.status === "Done" || task.epic.status === "Review")) {
      await tx.epic.update({
        where: { id: task.epic.id },
        data: {
          status: "In Progress",
          statusChangedAt: now,
          ...(task.epic.status === "Review"
            ? {
                completionReviewStatus: "Changes Requested",
                completionReviewCompletedAt: now,
                completionReviewLastError: reason.slice(0, 4000),
              }
            : {}),
        },
      });
      await tx.activityLog.create({
        data: {
          projectId: task.projectId,
          userId: actor?.id ?? null,
          kind: "epic.status",
          payload: JSON.stringify({ epicId: task.epic.id, from: task.epic.status, to: "In Progress", via: "epic_merge_failed" }),
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
  await drainWorkflowOutbox({ limit: 2 }).catch(() => {});
  publishBoardTouch(task.projectId);
}

// Deployment-watcher poll step (runs inside pm.service): select every Done
// Epic-child task whose branch has not yet been merged into its Epic branch
// and enqueue one spool job each for the pm-epic-merge-runner. No git runs
// here — the pm.service sandbox cannot do git work (see header).
export async function pollEpicTaskMerges(): Promise<{ checked: number; enqueued: number }> {
  const tasks = (await db.task.findMany({
    where: {
      status: "Done",
      epicId: { not: null },
      parentTaskId: null,
      deletedAt: null,
      archivedAt: null,
      project: { repositoryPath: { not: null } },
      // Legacy Done children have no repository run and their already-merged
      // refs may have been cleaned long ago. No-change submissions likewise
      // have no branch content to integrate.
      repositoryRun: { is: { repoTouched: true } },
      activity: { none: { kind: "pm.epic.merge.ok" } },
    },
    orderBy: { statusChangedAt: "asc" },
    take: 25,
    select: MERGE_CANDIDATE_SELECT,
  })) as MergeCandidate[];

  let checked = 0;
  let enqueued = 0;

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
      // re-scanning it every tick. No git involved, safe in-process.
      await recordMergeOk(task, epicBranch ?? "", { note: "no derivable branch" });
      continue;
    }

    checked++;
    try {
      const spooled = await enqueueEpicMergeJob({
        kind: "merge",
        jobId: `merge-${task.id}`,
        taskId: task.id,
        projectId: task.projectId,
        enqueuedAt: new Date().toISOString(),
      });
      if (spooled) enqueued++;
    } catch (err) {
      console.error("[pm] epic merge enqueue failed:", task.id, err);
    }
  }

  return { checked, enqueued };
}

// Epic-Done hook: queue Epic publication plus removal of merged LOCAL child
// branches/worktrees after whole-Epic acceptance (with guarded human/legacy
// Done paths as a fallback). The runner verifies each branch is an ancestor of
// the pushed Epic branch before deleting it. A leaked remote child ref is
// deleted only after the same ancestry proof.
export async function enqueueEpicDoneCleanup(epicId: string): Promise<{ enqueued: boolean; blockedByFailedJob?: boolean; note?: string }> {
  const epic = await db.epic.findUnique({
    where: { id: epicId },
    select: {
      id: true,
      status: true,
      projectId: true,
      workItemKey: true,
      branchName: true,
      project: { select: { repositoryPath: true } },
      // Include archived children: moving an Epic to Done archives its tasks
      // in the same transaction that precedes this hook.
      tasks: {
        where: { parentTaskId: null, deletedAt: null },
        select: {
          id: true,
          status: true,
          workItemKey: true,
          branchName: true,
          repositoryRun: { select: { repoTouched: true } },
          activity: {
            where: { kind: "pm.epic.merge.ok" },
            take: 1,
            select: { id: true },
          },
        },
      },
    },
  });
  if (!epic || epic.status !== "Done") return { enqueued: false, note: "epic not Done" };
  const repositoryPath = epic.project.repositoryPath;
  const epicBranch = effectiveEpicBranchName(epic);
  if (!repositoryPath || !epicBranch) return { enqueued: false, note: "no repository or epic branch" };

  const branches = [
    ...new Set(
      epic.tasks
        .map((task) => effectiveTaskBranchName({ ...task, epic }))
        .filter((branch): branch is string => Boolean(branch) && branch !== epicBranch),
    ),
  ];
  // A human Epic-Done transition archives its children in the transaction
  // immediately before this hook. Queue only those explicit children here;
  // the global poll remains restricted to unarchived live work and therefore
  // can never reconsider historical auto-archived Done tasks.
  for (const task of epic.tasks) {
    if (
      task.status !== "Done" ||
      task.repositoryRun?.repoTouched !== true ||
      task.activity.length > 0
    ) continue;
    await enqueueEpicMergeJob({
      kind: "merge",
      jobId: `merge-${task.id}`,
      taskId: task.id,
      projectId: epic.projectId,
      includeArchived: true,
      enqueuedAt: new Date().toISOString(),
    });
  }
  const cleanupJob: Extract<EpicMergeJob, { kind: "cleanup" }> = {
    kind: "cleanup",
    jobId: `cleanup-${epic.id}`,
    epicId: epic.id,
    projectId: epic.projectId,
    repositoryPath,
    epicBranch,
    branches,
    enqueuedAt: new Date().toISOString(),
  };
  const target = path.join(EPIC_MERGE_DIR, jobFileName(cleanupJob));
  const blockedByFailedJob = existsSync(`${target}.failed`);
  const spooled = await enqueueEpicMergeJob(cleanupJob);
  return { enqueued: Boolean(spooled), blockedByFailedJob };
}

// ---------------------------------------------------------------------------
// Runner-side execution (invoked by scripts/pm-epic-merge-job.ts inside the
// unsandboxed pm-epic-merge-runner service — it has DB access like
// pm-verify-branch-pushed.ts and full git/SSH capability).
// ---------------------------------------------------------------------------

const exec = promisify(execFile);

async function runGit(repo: string, args: string[], opts: { timeout?: number } = {}) {
  const { stdout } = await exec("git", ["-C", repo, ...args], {
    timeout: opts.timeout ?? 60_000,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

async function runGitOk(repo: string, args: string[], opts: { timeout?: number } = {}) {
  try {
    await runGit(repo, args, opts);
    return true;
  } catch {
    return false;
  }
}

async function activeRunnerBranchForRepository(repositoryPath: string): Promise<string | null> {
  try {
    const activeRoot = process.env.PM_APP_ROOT ?? process.cwd();
    const [repositoryCommon, activeCommon] = await Promise.all([
      runGit(repositoryPath, ["rev-parse", "--git-common-dir"]),
      runGit(activeRoot, ["rev-parse", "--git-common-dir"]),
    ]);
    const resolvedRepositoryCommon = path.resolve(repositoryPath, repositoryCommon);
    const resolvedActiveCommon = path.resolve(activeRoot, activeCommon);
    if (resolvedRepositoryCommon !== resolvedActiveCommon) return null;
    return (await runGit(activeRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"])) || null;
  } catch {
    return null;
  }
}

async function recordCompletionReviewOperationalError(args: {
  epicId: string;
  projectId: string;
  reason: string;
  via: string;
}) {
  const actor = await db.epic.findUnique({
    where: { id: args.epicId },
    select: { deployReviewerId: true },
  }).then((epic) => resolveEpicMergeActor(epic?.deployReviewerId ?? null));
  await db.$transaction(async (tx) => {
    await tx.epic.updateMany({
      where: { id: args.epicId, status: "Review" },
      data: {
        completionReviewStatus: "Operational Error",
        completionReviewLastError: args.reason.slice(0, 4000),
      },
    });
    if (actor) {
      await tx.comment.create({
        data: {
          epicId: args.epicId,
          userId: actor.id,
          body: [
            "🚫 Whole-Epic acceptance preparation stopped; the Epic remains in Review.",
            "",
            args.reason,
            "",
            "No completion or cleanup was performed. Resolve the repository/workflow condition, then retry the acceptance preparation.",
          ].join("\n"),
        },
      });
    }
    await tx.activityLog.create({
      data: {
        projectId: args.projectId,
        userId: actor?.id ?? null,
        kind: "epic.completion_review.operational_error",
        payload: JSON.stringify({ epicId: args.epicId, reason: args.reason, via: args.via }),
      },
    });
  });
  publishBoardTouch(args.projectId);
}

async function inspectEpicWorktree(args: {
  repositoryPath: string;
  epicBranch: string;
  candidateSha: string;
}) {
  const localRef = `refs/heads/${args.epicBranch}`;
  const localExists = await runGitOk(args.repositoryPath, ["show-ref", "--verify", "--quiet", localRef]);
  if (localExists) {
    const localSha = await runGit(args.repositoryPath, ["rev-parse", localRef]);
    if (localSha !== args.candidateSha) {
      return {
        ok: false as const,
        reason: `Local Epic branch ${args.epicBranch} is ${localSha}, but the frozen origin candidate is ${args.candidateSha}. Reconcile the local branch before acceptance review.`,
      };
    }
  }

  const records = (await runGit(args.repositoryPath, ["worktree", "list", "--porcelain"]))
    .split(/\n\s*\n/)
    .map((record) => record.split("\n"));
  const record = records.find((lines) => lines.includes(`branch ${localRef}`));
  const worktreePath = record?.find((line) => line.startsWith("worktree "))?.slice("worktree ".length) ?? null;
  if (!worktreePath) return { ok: true as const };

  const status = await runGit(worktreePath, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status) {
    const firstRows = status.split("\n").slice(0, 8).join(", ");
    return {
      ok: false as const,
      reason: `Epic worktree ${worktreePath} is not clean (${firstRows}). Preserve or reconcile those changes before acceptance review.`,
    };
  }
  const worktreeSha = await runGit(worktreePath, ["rev-parse", "HEAD"]);
  if (worktreeSha !== args.candidateSha) {
    return {
      ok: false as const,
      reason: `Epic worktree ${worktreePath} is at ${worktreeSha}, not frozen candidate ${args.candidateSha}.`,
    };
  }
  return { ok: true as const };
}

async function validateCompletionReviewCandidate(args: {
  epicId: string;
  expectedCandidateSha?: string | null;
  publish: boolean;
  publicationAttemptId?: string;
}) {
  const epic = await db.epic.findUnique({
    where: { id: args.epicId },
    select: {
      id: true,
      status: true,
      completionReviewStatus: true,
      completionReviewCandidateSha: true,
      projectId: true,
      workItemKey: true,
      branchName: true,
      project: { select: { repositoryPath: true } },
      tasks: {
        where: { parentTaskId: null, archivedAt: null, deletedAt: null },
        select: {
          id: true,
          workItemKey: true,
          title: true,
          status: true,
          repositoryRun: {
            select: { phase: true, repoTouched: true, reviewedSha: true },
          },
        },
      },
    },
  });
  if (!epic || epic.status !== "Review") {
    return { ok: false as const, reason: "Epic is no longer in Review." };
  }
  const openTask = epic.tasks.find((task) => task.status !== "Done");
  if (openTask) {
    return { ok: false as const, reason: `Child task ${openTask.workItemKey ?? openTask.id} is ${openTask.status}, not Done.` };
  }

  const repositoryPath = epic.project.repositoryPath;
  if (!repositoryPath) {
    if (args.expectedCandidateSha) {
      return { ok: false as const, reason: "A non-repository Epic cannot have a repository candidate SHA." };
    }
    return { ok: true as const, candidateSha: null, epicBranch: null };
  }
  const repositoryTasks = epic.tasks.filter((task) => task.repositoryRun?.repoTouched === true);
  if (repositoryTasks.length === 0) {
    if (args.expectedCandidateSha) {
      return { ok: false as const, reason: "This Epic has no repository-touching child candidate, but a repository SHA was recorded." };
    }
    return { ok: true as const, candidateSha: null, epicBranch: null };
  }
  const epicBranch = effectiveEpicBranchName(epic);
  if (!epicBranch) return { ok: false as const, reason: "The repository-backed Epic has no derivable integration branch." };

  const incomplete = repositoryTasks.find((task) =>
    task.repositoryRun?.phase !== "completed" || !task.repositoryRun.reviewedSha,
  );
  if (incomplete) {
    return {
      ok: false as const,
      reason: `Child task ${incomplete.workItemKey ?? incomplete.id} has no completed reviewed repository candidate.`,
    };
  }

  let candidateSha: string | null = null;
  if (args.publish) {
    if (!args.publicationAttemptId) throw new Error("Epic candidate publication requires its stable runner job identity.");
    const published = await publishWithDevLease({ projectId: epic.projectId, repositoryPath, branch: epicBranch, attemptId: args.publicationAttemptId, publish: beforePush => publishEpicBranch({ repoPath: repositoryPath, epicBranch, beforePush }) });
    if (!published.ok) return { ok: false as const, reason: published.reason, deferred: "deferred" in published && published.deferred === true };
    candidateSha = published.sha;
  } else {
    const remote = await inspectOriginBranch(repositoryPath, epicBranch);
    if (!remote.ok || !remote.sha) {
      return { ok: false as const, reason: remote.ok ? `Origin/${epicBranch} is missing.` : remote.reason };
    }
    candidateSha = remote.sha;
  }
  if (args.expectedCandidateSha !== undefined && candidateSha !== args.expectedCandidateSha) {
    return {
      ok: false as const,
      reason: `Origin/${epicBranch} moved from frozen candidate ${args.expectedCandidateSha ?? "(none)"} to ${candidateSha ?? "(missing)"}. A new acceptance review is required.`,
    };
  }

  await runGit(repositoryPath, [
    "fetch",
    "--quiet",
    "origin",
    `+refs/heads/${epicBranch}:refs/remotes/origin/${epicBranch}`,
  ]);
  for (const task of repositoryTasks) {
    const reviewedSha = task.repositoryRun?.reviewedSha;
    if (!reviewedSha) continue;
    const contained = await runGitOk(repositoryPath, [
      "merge-base",
      "--is-ancestor",
      reviewedSha,
      `refs/remotes/origin/${epicBranch}`,
    ]);
    if (!contained) {
      return {
        ok: false as const,
        reason: `Frozen Epic candidate does not contain reviewed child candidate ${reviewedSha} for ${task.workItemKey ?? task.id}.`,
      };
    }
  }

  const worktree = await inspectEpicWorktree({ repositoryPath, epicBranch, candidateSha });
  if (!worktree.ok) return worktree;
  return { ok: true as const, candidateSha, epicBranch };
}

async function executeCompletionReviewJob(job: Extract<EpicMergeJob, { kind: "review" }>) {
  const epic = await db.epic.findUnique({
    where: { id: job.epicId },
    select: { status: true, completionReviewStatus: true, deployReviewerId: true },
  });
  if (!epic || epic.status !== "Review" || epic.completionReviewStatus !== "Preparing") {
    return { epicId: job.epicId, outcome: "skipped" as const, note: "Epic is no longer preparing for review" };
  }
  // Task finalization and Epic-child integration are separate durable jobs.
  // The final Task may arm acceptance before its merge poll has queued/landed,
  // so wait instead of misclassifying that normal ordering window as an
  // operational failure.
  const pendingMerges = await db.task.count({
    where: {
      epicId: job.epicId,
      parentTaskId: null,
      deletedAt: null,
      status: "Done",
      repositoryRun: { is: { repoTouched: true } },
      activity: { none: { kind: "pm.epic.merge.ok" } },
    },
  });
  if (pendingMerges > 0) {
    return {
      epicId: job.epicId,
      outcome: "deferred" as const,
      note: `${pendingMerges} child merge(s) still pending before whole-Epic acceptance`,
    };
  }
  let validated;
  try {
    validated = await validateCompletionReviewCandidate({ epicId: job.epicId, publish: true, publicationAttemptId: job.jobId });
  } catch (error) {
    validated = { ok: false as const, reason: String(error instanceof Error ? error.message : error) };
  }
  if (!validated.ok) {
    if ("deferred" in validated && validated.deferred) return { epicId: job.epicId, outcome: "deferred" as const, reason: validated.reason };
    await recordCompletionReviewOperationalError({
      epicId: job.epicId,
      projectId: job.projectId,
      reason: validated.reason,
      via: "completion_review_prepare",
    });
    return { epicId: job.epicId, outcome: "operational-error" as const, reason: validated.reason };
  }

  const actor = await resolveEpicMergeActor(epic.deployReviewerId);
  if (!actor) {
    const reason = "No active Deploy Reviewer or unique Monitor Agent is available for the whole-Epic acceptance review.";
    await recordCompletionReviewOperationalError({ epicId: job.epicId, projectId: job.projectId, reason, via: "completion_review_prepare" });
    return { epicId: job.epicId, outcome: "operational-error" as const, reason };
  }
  const now = new Date();
  await db.$transaction(async (tx) => {
    await tx.epic.update({
      where: { id: job.epicId },
      data: {
        completionReviewStatus: "Pending",
        completionReviewCandidateSha: validated.candidateSha,
        completionReviewRequestedAt: now,
        completionReviewCompletedAt: null,
        completionReviewLastError: null,
      },
    });
    await tx.activityLog.create({
      data: {
        projectId: job.projectId,
        userId: actor.id,
        kind: "epic.completion_review.requested",
        targetAgent: actor.username,
        payload: JSON.stringify({
          epicId: job.epicId,
          candidateSha: validated.candidateSha,
          epicBranch: validated.epicBranch,
        }),
      },
    });
  });
  const { triggerCompletionReview } = await import("@/lib/epics/completion-review");
  let dispatched = false;
  try {
    dispatched = await triggerCompletionReview({ epicId: job.epicId, actorId: actor.id });
  } catch (error) {
    const reason = `Reviewer dispatch failed: ${String(error instanceof Error ? error.message : error).slice(0, 3800)}`;
    await recordCompletionReviewOperationalError({
      epicId: job.epicId,
      projectId: job.projectId,
      reason,
      via: "completion_review_dispatch",
    });
    return { epicId: job.epicId, outcome: "operational-error" as const, reason };
  }
  publishBoardTouch(job.projectId);
  return { epicId: job.epicId, outcome: dispatched ? "pending" as const : "dispatch-failed" as const, candidateSha: validated.candidateSha };
}

async function executeCompletionReviewApprovalJob(job: Extract<EpicMergeJob, { kind: "review-approval" }>) {
  const epic = await db.epic.findUnique({
    where: { id: job.epicId },
    select: { status: true, completionReviewStatus: true, completionReviewCandidateSha: true },
  });
  if (
    !epic || epic.status !== "Review" || epic.completionReviewStatus !== "Approval Pending" ||
    epic.completionReviewCandidateSha !== job.expectedCandidateSha
  ) {
    return { epicId: job.epicId, outcome: "skipped" as const, note: "Epic approval is no longer pending for this candidate" };
  }
  let validated;
  try {
    validated = await validateCompletionReviewCandidate({
      epicId: job.epicId,
      expectedCandidateSha: job.expectedCandidateSha,
      publish: false,
    });
  } catch (error) {
    validated = { ok: false as const, reason: String(error instanceof Error ? error.message : error) };
  }
  if (!validated.ok) {
    await recordCompletionReviewOperationalError({
      epicId: job.epicId,
      projectId: job.projectId,
      reason: validated.reason,
      via: "completion_review_approval_verify",
    });
    return { epicId: job.epicId, outcome: "operational-error" as const, reason: validated.reason };
  }

  const now = new Date();
  const cleanupEffectCount = await db.$transaction(async (tx) => {
    await assertEpicReleaseChecksComplete(tx, job.epicId);
    await tx.epic.update({
      where: { id: job.epicId },
      data: {
        status: "Done",
        statusChangedAt: now,
        completionReviewStatus: "Approved",
        completionReviewCompletedAt: now,
        completionReviewLastError: null,
      },
    });
    await tx.activityLog.create({
      data: {
        projectId: job.projectId,
        userId: job.requestedByUserId,
        kind: "epic.completion_review.approve",
        targetAgent: job.requestedByUsername,
        payload: JSON.stringify({ epicId: job.epicId, candidateSha: validated.candidateSha }),
      },
    });
    await tx.activityLog.create({
      data: {
        projectId: job.projectId,
        userId: job.requestedByUserId,
        kind: "epic.status",
        targetAgent: job.requestedByUsername,
        payload: JSON.stringify({
          epicId: job.epicId,
          from: "Review",
          to: "Done",
          via: "completion_review_approval_verify",
          action: "epic_review_done",
          candidateSha: validated.candidateSha,
        }),
      },
    });
    const anchor = await tx.task.findFirst({
      where: { epicId: job.epicId, parentTaskId: null, deletedAt: null },
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
      select: { id: true, workflowVersion: true },
    });
    if (!anchor) throw new Error("Whole-Epic approval has no live child Task for durable cleanup.");
    await enqueueWorkflowEffects(tx, {
      taskId: anchor.id,
      projectId: job.projectId,
      aggregateVersion: anchor.workflowVersion,
      effects: [{
        type: "epic_cleanup",
        key: `completion-review-cleanup:${job.epicId}:${validated.candidateSha ?? "no-repository"}`,
        payload: { epicId: job.epicId },
      }],
    });
    return 1;
  });
  await drainWorkflowOutbox({ limit: cleanupEffectCount }).catch((error) =>
    console.error("[pm] whole-Epic cleanup outbox drain deferred:", job.epicId, error),
  );
  publishBoardTouch(job.projectId);
  return { epicId: job.epicId, outcome: "done" as const, candidateSha: validated.candidateSha };
}

async function executeMergeJob(job: Extract<EpicMergeJob, { kind: "merge" }>) {
  // Re-load the candidate with the poll's exact predicate: the task may have
  // moved, been merged, or been bounced between enqueue and execution.
  const task = (await db.task.findFirst({
    where: {
      id: job.taskId,
      status: "Done",
      epicId: { not: null },
      parentTaskId: null,
      deletedAt: null,
      ...(job.includeArchived ? {} : { archivedAt: null }),
      project: { repositoryPath: { not: null } },
      // Re-check the same compatibility guard after the runner claims a job.
      repositoryRun: { is: { repoTouched: true } },
      activity: { none: { kind: "pm.epic.merge.ok" } },
    },
    select: MERGE_CANDIDATE_SELECT,
  })) as MergeCandidate | null;
  if (!task) return { taskId: job.taskId, outcome: "skipped" as const, note: "no longer a merge candidate" };

  const repoPath = task.project.repositoryPath!;
  const epicBranch = task.epic ? effectiveEpicBranchName(task.epic) : null;
  const taskBranch = effectiveTaskBranchName({
    workItemKey: task.workItemKey,
    branchName: task.branchName,
    epic: task.epic,
  });
  if (!epicBranch || !taskBranch) {
    await recordMergeOk(task, epicBranch ?? "", { note: "no derivable branch" });
    return { taskId: task.id, outcome: "noop" as const, note: "no derivable branch" };
  }

  const baseBranch = await productionBranchFor(task.projectId);
  const remoteTaskBranch = await inspectOriginBranch(repoPath, taskBranch);
  const remoteTaskBranchSha = remoteTaskBranch.ok ? remoteTaskBranch.sha : null;
  const result = await publishWithDevLease({ projectId: task.projectId, taskId: task.id, repositoryPath: repoPath, branch: epicBranch, attemptId: job.jobId, publish: beforePush => mergeTaskBranchIntoEpic({
    beforePush, repoPath,
    epicBranch,
    taskBranch,
    baseBranch,
    gitUserName: task.project.defaultGitUserName?.trim() || "PM Monitor",
    gitUserEmail: task.project.defaultGitUserEmail?.trim() || "pm-monitor@localhost",
    message: `Merge ${task.workItemKey ?? taskBranch} into Epic branch ${epicBranch}`,
  }) });
  if (result.ok) {
    await recordMergeOk(task, epicBranch, {
      taskBranch,
      kind: result.kind,
      ...(result.kind === "merged" ? { sha: result.sha } : {}),
      ...(result.kind === "noop" ? { note: result.note } : {}),
      ...(remoteTaskBranchSha
        ? { unexpectedRemoteTaskBranchSha: remoteTaskBranchSha }
        : {}),
    });
    // This compatibility path merges a task that was already Done before the
    // publication lease existed, so its normal Done transition cannot release it.
    await db.$transaction(tx => releaseTaskDevLease(tx, { taskId: task.id }));
    if (remoteTaskBranchSha) {
      const monitor = await monitorAgentUser();
      await db.$transaction(async (tx) => {
        if (monitor) {
          await tx.comment.create({
            data: {
              taskId: task.id,
              userId: monitor.id,
              body: [
                `⚠️ Epic-child policy breach detected: \`origin/${taskBranch}\` exists at \`${remoteTaskBranchSha.slice(0, 10)}\`.`,
                `PM preserved the work by merging it into the Epic branch \`${epicBranch}\`. The leaked remote task ref will be removed only after ancestry is verified against the pushed Epic branch during Epic-Done finalization.`,
              ].join("\n\n"),
              commentKind: "workflow_action",
              isGenerated: true,
            },
          });
        }
        await tx.activityLog.create({
          data: {
            projectId: task.projectId,
            taskId: task.id,
            userId: monitor?.id ?? null,
            kind: "pm.epic.remote_branch.detected",
            payload: JSON.stringify({
              taskId: task.id,
              taskBranch,
              remoteSha: remoteTaskBranchSha,
              epicBranch,
            }),
          },
        });
      });
    }
    return { taskId: task.id, outcome: result.kind, epicBranch, taskBranch };
  }
  if ("deferred" in result && result.deferred) return { taskId: task.id, outcome: "deferred" as const, reason: result.reason };
  await bounceTaskToReview({ task, epicBranch, taskBranch, reason: result.reason });
  return { taskId: task.id, outcome: "bounced" as const, epicBranch, taskBranch, reason: result.reason };
}

type LocalCleanupItem = {
  branch: string;
  outcome: "removed" | "absent" | "failed" | "needs-root";
  detail: string | null;
};

type CleanupItem = LocalCleanupItem & {
  remoteOutcome: "removed" | "absent" | "failed";
  remoteDetail: string | null;
};

function isPermissionError(detail: string) {
  return /permission denied|operation not permitted|read-only file system/i.test(detail);
}

// Locate the repo-relative worktree-remove helper first (versioned with this
// worktree), falling back to the host-installed copy.
function worktreeRemoveScript() {
  const override = process.env.PM_WORKTREE_REMOVE_SCRIPT;
  if (override) return override;
  const local = path.join(process.cwd(), "deploy", "worktree-remove");
  return existsSync(local) ? local : "/usr/local/sbin/worktree-remove";
}

async function removeLocalBranch(job: Extract<EpicMergeJob, { kind: "cleanup" }>, branch: string): Promise<LocalCleanupItem> {
  const repo = job.repositoryPath;
  const hasLocal = await runGitOk(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`]);
  if (!hasLocal) return { branch, outcome: "absent", detail: null };

  const merged = await runGitOk(repo, [
    "merge-base",
    "--is-ancestor",
    `refs/heads/${branch}`,
    `refs/remotes/origin/${job.epicBranch}`,
  ]);
  if (!merged) {
    return {
      branch,
      outcome: "failed",
      detail: `not an ancestor of the pushed Epic branch \`${job.epicBranch}\` — left in place`,
    };
  }

  try {
    // Branch-only mode of the shared cleanup helper: removes the branch's
    // clean worktree (when one exists under <repo>.worktrees) then deletes
    // the local ref. Never contacts origin.
    await exec(
      "python3",
      [
        worktreeRemoveScript(),
        "--branch",
        repo,
        `${repo}.worktrees`,
        branch,
        JSON.stringify([job.epicBranch]),
      ],
      { timeout: 60_000, maxBuffer: 1024 * 1024 },
    );
    return { branch, outcome: "removed", detail: null };
  } catch (err) {
    const anyErr = err as { stderr?: string; stdout?: string; message?: string };
    const detail = (anyErr.stderr || anyErr.stdout || anyErr.message || String(err)).trim().slice(0, 400);
    return { branch, outcome: isPermissionError(detail) ? "needs-root" : "failed", detail };
  }
}

async function removeFinalizedTaskWorktree(
  repositoryPath: string,
  branch: string,
  protectedBranches: string[],
) {
  try {
    await exec(
      "python3",
      [
        worktreeRemoveScript(),
        "--branch",
        repositoryPath,
        `${repositoryPath}.worktrees`,
        branch,
        JSON.stringify(protectedBranches),
      ],
      { timeout: 60_000, maxBuffer: 1024 * 1024 },
    );
    return { ok: true as const };
  } catch (err) {
    const anyErr = err as { stderr?: string; stdout?: string; message?: string };
    const error = String(anyErr.stderr || anyErr.stdout || anyErr.message || err)
      .trim()
      .slice(0, 800);
    return { ok: false as const, error };
  }
}

async function executeCheckpointJob(
  job: Extract<EpicMergeJob, { kind: "checkpoint" }>,
) {
  const task = await db.task.findUnique({
    where: { id: job.taskId },
    select: {
      id: true,
      title: true,
      status: true,
      projectId: true,
      workItemKey: true,
      branchName: true,
      commitPrefix: true,
      assigneeId: true,
      approvedOn: true,
      project: {
        select: {
          repositoryPath: true,
          defaultGitUserName: true,
          defaultGitUserEmail: true,
          deploymentProductionBranch: true,
          deploymentPrTargetBranch: true,
          agentChangeBlockedBranches: true,
        },
      },
      epic: {
        select: {
          id: true,
          status: true,
          workItemKey: true,
          branchName: true,
          commitPrefix: true,
        },
      },
      repositoryRun: {
        select: {
          phase: true,
          baseSha: true,
          repositoryPath: true,
          branchName: true,
          worktreePath: true,
          epicBranch: true,
        },
      },
    },
  });
  if (!task || task.status !== "In Progress") {
    return { taskId: job.taskId, outcome: "skipped" as const, note: "task is no longer In Progress" };
  }

  const monitor = await resolveActiveMonitorAgent();
  const actor = monitor.ok
    ? { id: monitor.user.id, username: monitor.user.username, kind: "agent" as const }
    : null;
  const fail = async (reason: string) => {
    await updateTaskRepositoryState(task.id, {
      phase: "active",
      lastError: reason,
    });
    await db.$transaction([
      db.task.update({ where: { id: task.id }, data: { alertReporter: true } }),
      ...(actor
        ? [db.comment.create({
            data: {
              taskId: task.id,
              userId: actor.id,
              body: [
                "🚫 PM could not publish the authorized mid-task checkpoint. The task remains In Progress and its worktree was preserved.",
                "",
                reason,
              ].join("\n"),
              commentKind: "workflow_action",
              isGenerated: true,
            },
          })]
        : []),
      db.activityLog.create({
        data: {
          projectId: task.projectId,
          taskId: task.id,
          userId: actor?.id ?? null,
          kind: "pm.repo.checkpoint.fail",
          payload: JSON.stringify({
            jobId: job.jobId,
            authorizationCommentId: job.authorizationCommentId,
            requestedByUserId: job.requestedByUserId,
            reason,
          }),
        },
      }),
    ]);
    const blockerSettlement = job.standingAuthorizationId ? { cleared: false } : await settleConsumedCheckpointBlocker({
      taskId: task.id,
      projectId: task.projectId,
      authorizationCommentId: job.authorizationCommentId,
      requestedByUsername: job.requestedByUsername,
      actor,
      outcome: "checkpoint_failed",
      evidence: reason,
      alertAfterFailure: true,
    });
    if (actor && task.assigneeId) {
      const continuation = await queueTaskExecutionContinuation({ taskId: task.id, agentSlug: job.requestedByUsername, action: "checkpoint_failed", eventKey: job.publicationAttemptId ?? job.authorizationCommentId });
      if (!continuation.scheduled) await sendTaskWorkflowNotification({
        taskId: task.id,
        targetUserId: task.assigneeId,
        actor,
        reason: "checkpoint_failed",
        body: [
          `PM could not publish the authorized checkpoint for "${task.title}".`,
          reason,
          job.standingAuthorizationId
            ? "The standing grant was not consumed. Resume the same publication attempt to reconcile its exact SHA and Dev reservation; scope or configuration changes require fresh plan approval."
            : blockerSettlement.cleared
            ? "PM closed the consumed permission round. The task remains In Progress and the worktree is preserved. Diagnose the reported repository problem, fix agent-actionable work, then raise a fresh publish_checkpoint blocker for any retry. Use a general blocker only if evidence proves a genuine human/external dependency."
            : "The task remains In Progress and the worktree is preserved. Diagnose the reported repository problem and continue from the current formal-blocker state.",
        ].join("\n"),
      }).catch((err) => console.error("[pm] checkpoint failure notify failed:", task.id, err));
    }
    publishBoardTouch(task.projectId);
    return { taskId: task.id, outcome: "failed" as const, reason };
  };

  if (!actor) {
    return fail(monitor.ok ? "No active Monitor Agent is available." : monitor.error);
  }
  // A completed grant has deliberately closed its blocker. A replay repairs
  // settlement only; it must not reauthorize or republish under that spent grant.
  const priorSuccessfulUses = await db.activityLog.findMany({
    where: { taskId: task.id, kind: "pm.repo.checkpoint.ok" },
    select: { payload: true },
  });
  const priorSuccessfulUse = priorSuccessfulUses.find((entry) =>
    activityPayloadUsesCheckpointAuthorization(entry.payload, job.authorizationCommentId)
  );
  if (priorSuccessfulUse) {
    let evidence = "PM had already recorded a successful publication for this authorization.";
    try {
      const parsed = JSON.parse(priorSuccessfulUse.payload ?? "{}") as { epicSha?: unknown; publishedSha?: unknown };
      const publishedSha = parsed.publishedSha ?? parsed.epicSha;
      if (typeof publishedSha === "string") evidence += ` Published SHA: \`${publishedSha}\`.`;
    } catch {
      // The authorization match itself is sufficient for idempotent repair.
    }
    const settlement = await settleConsumedCheckpointBlocker({
      taskId: task.id,
      projectId: task.projectId,
      authorizationCommentId: job.authorizationCommentId,
      requestedByUsername: job.requestedByUsername,
      actor,
      outcome: "checkpoint_published",
      evidence,
    });
    if (settlement.cleared) publishBoardTouch(task.projectId);
    return {
      taskId: task.id,
      outcome: "done" as const,
      note: settlement.cleared
        ? "reconciled the consumed checkpoint blocker after an earlier successful publication"
        : "checkpoint authorization was already published and its permission round was already settled",
    };
  }

  if (!task.approvedOn) return fail("The Task Action Plan is no longer approved.");
  if (task.assigneeId !== job.requestedByUserId) {
    return fail("The agent that requested this checkpoint is no longer the task assignee.");
  }
  if (task.epic && task.epic.status !== "In Progress") {
    return fail("An Epic-child checkpoint requires its Epic to remain In Progress.");
  }
  if (task.repositoryRun?.phase !== "active") return fail("The checkpoint repository run is no longer active.");

  const standingAuthority = job.standingAuthorizationId
    ? await validateStandingAuthorization(db, { taskId: task.id, grantId: job.standingAuthorizationId, assigneeId: job.requestedByUserId })
    : null;
  if (standingAuthority && !standingAuthority.ok) return fail(standingAuthority.reason);
  const authorization = job.standingAuthorizationId ? null : await db.comment.findUnique({
    where: { id: job.authorizationCommentId },
    select: {
      taskId: true,
      body: true,
      createdAt: true,
      deletedAt: true,
      user: { select: { id: true, kind: true, status: true, isOwner: true } },
    },
  });
  const reviewerGrant = authorization && await isReviewerCheckpointAuthorization(db, task.id, job.authorizationCommentId);
  if (!job.standingAuthorizationId && (
    !authorization ||
    authorization.taskId !== task.id ||
    authorization.deletedAt ||
    authorization.createdAt < task.approvedOn ||
    (!isActiveOwnerPrincipal(authorization.user) && !reviewerGrant)
  )) {
    return fail("The checkpoint authorization comment is missing, deleted, predates plan approval, or is not a live owner/scoped reviewer grant.");
  }

  const repositoryPath = task.repositoryRun?.repositoryPath ?? task.project.repositoryPath;
  const worktreePath = task.repositoryRun?.worktreePath;
  const taskBranch = task.repositoryRun?.branchName ?? effectiveTaskBranchName(task);
  const epicBranch = task.epic ? task.repositoryRun?.epicBranch ?? effectiveEpicBranchName(task.epic) : null;
  const publishedBranch = epicBranch ?? taskBranch;
  if (!repositoryPath || !worktreePath || !taskBranch || !publishedBranch) {
    return fail("The active repository path, worktree, task branch, or Epic branch is missing.");
  }
  const explicitAuthorization = reviewerGrant || standingAuthority?.ok ? { ok: true as const } : validateCheckpointAuthorizationText({
    body: authorization!.body,
    taskKey: task.workItemKey,
    taskBranch,
    epicBranch,
  });
  if (!explicitAuthorization.ok) {
    return fail(`The cited owner comment is not an explicit checkpoint capability: ${explicitAuthorization.reason}`);
  }
  if (isProtectedBranch(task.project.agentChangeBlockedBranches, publishedBranch)) {
    return fail(`The publication branch ${publishedBranch} is protected from agent-originated repository changes.`);
  }

  const settings = await resolveEffectiveProjectSettings({
    id: task.projectId,
    defaultGitUserName: task.project.defaultGitUserName,
    defaultGitUserEmail: task.project.defaultGitUserEmail,
    deploymentProductionBranch: task.project.deploymentProductionBranch,
    deploymentPrTargetBranch: task.project.deploymentPrTargetBranch,
  });
  const gitUserName = settings.gitIdentity.name.value;
  const gitUserEmail = settings.gitIdentity.email.value;
  if (!gitUserName || !gitUserEmail) {
    return fail("The effective project Git identity is incomplete; PM cannot create the checkpoint commit.");
  }
  const prefix = effectiveTaskCommitPrefix(task);
  const checkpoint = await publishWithDevLease({
    projectId: task.projectId, taskId: task.id, repositoryPath, branch: publishedBranch,
    attemptId: job.publicationAttemptId ?? `checkpoint:${job.authorizationCommentId}`, grantId: job.standingAuthorizationId,
    publish: beforePush => epicBranch ? publishTaskCheckpointToEpic({
    beforePush, repoPath: repositoryPath,
    worktreePath,
    epicBranch,
    taskBranch,
    baseBranch: settings.deployment.productionBranch.value,
    previousBaseSha: task.repositoryRun?.baseSha ?? null,
    gitUserName,
    gitUserEmail,
    commitSubject: `${prefix ? `${prefix} ` : ""}${task.title}`,
    mergeMessage: `Checkpoint ${task.workItemKey ?? taskBranch} into Epic branch ${epicBranch}`,
  }) : publishStandaloneTaskCheckpoint({
    beforePush, repoPath: repositoryPath, worktreePath, taskBranch,
    baseBranch: settings.deployment.productionBranch.value,
    gitUserName, gitUserEmail,
    commitSubject: `${prefix ? `${prefix} ` : ""}${task.title}`,
    authorizationCommentId: job.authorizationCommentId,
  }).then(result => result.ok ? { ...result, epicSha: result.publishedSha } : result),
  });
  if (!checkpoint.ok) {
    if ("deferred" in checkpoint && checkpoint.deferred) return { taskId: task.id, outcome: "deferred" as const, note: checkpoint.reason };
    return fail(checkpoint.reason);
  }

  await updateTaskRepositoryState(task.id, {
    phase: "active",
    // The published Epic tip is the new implementation baseline. This lets a
    // later no-change handoff prove that all earlier changes were checkpointed,
    // while a later code-changing handoff verifies only work since checkpoint.
    // Standalone review must still see the full original implementation diff.
    baseSha: epicBranch ? checkpoint.epicSha : task.repositoryRun?.baseSha ?? null,
    candidateSha: null,
    reviewedSha: null,
    validationOutcome: null,
    repoTouched: null,
    lastError: null,
  });
  const body = [
    `✅ PM published the authorized mid-task checkpoint to ${epicBranch ? "Epic" : "standalone task"} branch \`${publishedBranch}\`.`,
    "",
    `- Task checkpoint: \`${checkpoint.checkpointSha.slice(0, 10)}\``,
    `- Published branch tip: \`${checkpoint.epicSha.slice(0, 10)}\``,
    job.standingAuthorizationId ? `- Standing authorization: \`${job.standingAuthorizationId}\`; attempt: \`${job.publicationAttemptId}\`` : `- Authorization comment: \`${job.authorizationCommentId}\``,
    "- The task remains In Progress; its task branch and worktree remain active. Verification and independent review are still required.",
    "",
    job.note,
  ].join("\n");
  await db.$transaction([
    db.comment.create({ data: { taskId: task.id, userId: actor.id, body, commentKind: "workflow_action", isGenerated: true } }),
    db.activityLog.create({
      data: {
        projectId: task.projectId,
        taskId: task.id,
        userId: actor.id,
        kind: "pm.repo.checkpoint.ok",
        payload: JSON.stringify({
          jobId: job.jobId,
          authorizationCommentId: job.authorizationCommentId,
          authorizationUserId: standingAuthority?.ok ? standingAuthority.grant.grantedById : authorization!.user.id,
          standingAuthorizationId: job.standingAuthorizationId,
          publicationAttemptId: job.publicationAttemptId,
          requestedByUserId: job.requestedByUserId,
          taskBranch,
          epicBranch,
          checkpointSha: checkpoint.checkpointSha,
          epicSha: epicBranch ? checkpoint.epicSha : null,
          publishedSha: checkpoint.epicSha,
          publishedBranch,
          createdCommit: checkpoint.createdCommit,
          kind: checkpoint.kind,
        }),
      },
    }),
  ]);
  const blockerSettlement = job.standingAuthorizationId ? { cleared: false } : await settleConsumedCheckpointBlocker({
    taskId: task.id,
    projectId: task.projectId,
    authorizationCommentId: job.authorizationCommentId,
    requestedByUsername: job.requestedByUsername,
    actor,
    outcome: "checkpoint_published",
    evidence: `Publication produced SHA \`${checkpoint.epicSha}\` on ${publishedBranch}.`,
  });
  if (task.assigneeId) {
    const continuation = await queueTaskExecutionContinuation({ taskId: task.id, agentSlug: job.requestedByUsername, action: "checkpoint_published", eventKey: job.publicationAttemptId ?? job.authorizationCommentId });
    if (!continuation.scheduled) await sendTaskWorkflowNotification({
      taskId: task.id,
      targetUserId: task.assigneeId,
      actor,
      reason: "checkpoint_published",
      body: [
        `PM published the authorized checkpoint for "${task.title}" to origin/${publishedBranch} at ${checkpoint.epicSha}.`,
        ...(job.standingAuthorizationId ? ["The registered Dev target verified this exact SHA. The bounded standing grant remains valid; continue the approved verification without another permission round."] : []),
        ...(blockerSettlement.cleared
          ? ["PM automatically cleared the consumed publish_checkpoint permission blocker. If deployed verification exposes a new code change that requires another publication, fix it, then raise a fresh publish_checkpoint blocker so the reporter receives a new single-use grant action."]
          : []),
        epicBranch
          ? "The task remains In Progress. The configured project automation owns deployment of this exact Epic SHA; do not use manual SSH/Git as a fallback. Verify the deployed SHA, complete live verification, then use ready_for_review."
          : "The task remains In Progress. Deploy this exact published task SHA through the configured test deployment or the explicitly owner-authorized test flow. Check the actual served revision before testing. Complete the remaining verification and then use ready_for_review; the original review baseline is preserved.",
      ].join("\n"),
    }).catch((err) => console.error("[pm] checkpoint success notify failed:", task.id, err));
  }
  publishBoardTouch(task.projectId);
  return {
    taskId: task.id,
    outcome: checkpoint.kind,
    checkpointSha: checkpoint.checkpointSha,
    publishedSha: checkpoint.epicSha,
    publishedBranch,
    epicSha: epicBranch ? checkpoint.epicSha : null,
    epicBranch,
  };
}

type FinalizationCorrelation =
  | { ok: true; mode: "v2-exact"; replay: boolean }
  | { ok: false; reason: string };

function finalizationCorrelationFingerprint(
  job: Extract<EpicMergeJob, { kind: "finalize" }>,
  reason: string,
) {
  return createHash("sha256").update([
    job.taskId,
    job.workflowCycleId ?? "null",
    job.procedureRunId ?? "null",
    job.procedureStepId ?? "null",
    job.jobId,
    job.repositoryRunId ?? "null",
    job.repositoryRunVersion ?? "null",
    job.candidateSha,
    job.baseSha ?? "null",
    reason,
  ].join("\0")).digest("hex").slice(0, 32);
}

async function recordFinalizationCorrelationRejection(args: {
  taskId: string;
  projectId: string;
  job: Extract<EpicMergeJob, { kind: "finalize" }>;
  reason: string;
}) {
  const fingerprint = finalizationCorrelationFingerprint(args.job, args.reason);
  const existing = await db.activityLog.findFirst({
    where: {
      taskId: args.taskId,
      kind: "task.workflow.procedure_callback_rejected",
      payload: { contains: fingerprint },
      createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1_000) },
    },
    select: { id: true },
  });
  if (existing) return;
  await db.activityLog.create({
    data: {
      projectId: args.projectId,
      taskId: args.taskId,
      kind: "task.workflow.procedure_callback_rejected",
      payload: JSON.stringify({
        fingerprint,
        correlationPath: "epic-finalization-preflight",
        reason: args.reason,
        job: args.job,
      }),
    },
  });
}

async function validateFinalizationCorrelation(
  task: {
    id: string;
    projectId: string;
    activeWorkflowCycleId: string | null;
    repositoryRun: {
      id: string;
      version: number;
      baseSha: string | null;
      candidateSha: string | null;
    } | null;
  },
  job: Extract<EpicMergeJob, { kind: "finalize" }>,
): Promise<FinalizationCorrelation> {
  const ownership = await resolveEngineOwnership(db, task.id);
  if (!ownership.ok) return { ok: false, reason: ownership.reason };

  if (ownership.engine !== ENGINE_ORCHESTRATOR_V2 || job.schemaVersion !== 2) {
    return { ok: false, reason: "Legacy finalization jobs are retired; exact V2 ownership is required." };
  }

  if (
    !job.procedureRunId ||
    !job.procedureStepId ||
    typeof job.workflowCycleId !== "string" ||
    !job.repositoryRunId ||
    typeof job.repositoryRunVersion !== "number"
  ) {
    return { ok: false, reason: "V2 finalization job is missing exact procedure, cycle, or repository-run identity." };
  }
  if (job.projectId !== task.projectId) {
    return { ok: false, reason: "Finalization job project does not match the task project." };
  }
  const step = await db.taskProcedureStep.findUnique({
    where: { id: job.procedureStepId },
    select: {
      id: true,
      status: true,
      output: true,
      procedureRun: {
        select: { id: true, taskId: true, workflowCycleId: true, type: true },
      },
    },
  });
  if (!step ||
    step.procedureRun.id !== job.procedureRunId ||
    step.procedureRun.taskId !== task.id ||
    step.procedureRun.workflowCycleId !== job.workflowCycleId ||
    step.procedureRun.type !== "finalize_accepted_review"
  ) {
    return { ok: false, reason: "Finalization job does not match the exact procedure step owner." };
  }
  let expected: Record<string, unknown> = {};
  if (step.output) {
    try { expected = JSON.parse(step.output) as Record<string, unknown>; } catch { /* malformed output is rejected below */ }
  }
  if (
    expected.jobId !== job.jobId ||
    expected.schemaVersion !== 2 ||
    (expected.commandReceiptId ?? null) !== (job.commandReceiptId ?? null) ||
    expected.repositoryRunId !== job.repositoryRunId ||
    expected.repositoryRunVersion !== job.repositoryRunVersion ||
    expected.candidateSha !== job.candidateSha ||
    (expected.baseSha ?? null) !== (job.baseSha ?? null)
  ) {
    return { ok: false, reason: "Finalization job identity differs from the waiting procedure step." };
  }
  if (step.status === "completed") {
    return { ok: true, mode: "v2-exact", replay: true };
  }
  if (
    expected.taskId !== task.id ||
    expected.workflowCycleId !== job.workflowCycleId ||
    expected.procedureRunId !== job.procedureRunId ||
    expected.procedureStepId !== job.procedureStepId
  ) {
    return { ok: false, reason: "Finalization job owner identity differs from the waiting procedure step." };
  }
  if (!task.repositoryRun ||
    task.repositoryRun.id !== job.repositoryRunId ||
    task.repositoryRun.version !== job.repositoryRunVersion ||
    task.repositoryRun.candidateSha !== job.candidateSha ||
    task.repositoryRun.baseSha !== (job.baseSha ?? null)
  ) {
    return { ok: false, reason: "Finalization job identity differs from the current repository run." };
  }
  if (step.status !== "waiting_callback") {
    return { ok: false, reason: `Finalization procedure step is ${step.status}, not waiting_callback.` };
  }
  if (task.activeWorkflowCycleId !== job.workflowCycleId) {
    return { ok: false, reason: "Finalization job no longer belongs to the task's active workflow cycle." };
  }
  return { ok: true, mode: "v2-exact", replay: false };
}

async function applyExactFinalizationJobCallback(args: {
  job: Extract<EpicMergeJob, { kind: "finalize" }>;
  taskId: string;
  ok: boolean;
  mergeSha?: string | null;
  error?: string;
}) {
  const { applyProcedureCallback } = await import("@/lib/tasks/orchestrator/procedure-runner");
  return applyProcedureCallback({
    procedureRunId: args.job.procedureRunId!,
    stepId: args.job.procedureStepId!,
    taskId: args.taskId,
    workflowCycleId: args.job.workflowCycleId!,
    jobId: args.job.jobId,
    candidateSha: args.job.candidateSha,
    baseSha: args.job.baseSha ?? null,
    schemaVersion: args.job.schemaVersion,
    commandReceiptId: args.job.commandReceiptId ?? null,
    repositoryRunId: args.job.repositoryRunId ?? null,
    repositoryRunVersion: args.job.repositoryRunVersion ?? null,
    data: {
      finalizationOk: args.ok,
      mergeSha: args.mergeSha ?? undefined,
      error: args.error,
    },
  });
}

async function executeFinalizeJob(
  job: Extract<EpicMergeJob, { kind: "finalize" }>,
) {
  const task = await db.task.findUnique({
    where: { id: job.taskId },
    select: {
      id: true,
      title: true,
      status: true,
      activeWorkflowCycleId: true,
      projectId: true,
      workItemKey: true,
      branchName: true,
      project: {
        select: {
          repositoryPath: true,
          defaultGitUserName: true,
          defaultGitUserEmail: true,
        },
      },
      epic: {
        select: {
          id: true,
          workItemKey: true,
          branchName: true,
          commitPrefix: true,
        },
      },
      repositoryRun: {
        select: {
          id: true,
          version: true,
          baseSha: true,
          candidateSha: true,
          repoTouched: true,
          worktreePath: true,
          validationOutcome: true,
          reviewedSha: true,
        },
      },
      activity: {
        where: { kind: "pm.epic.merge.ok" },
        orderBy: { createdAt: "desc" },
        take: 20,
        select: { payload: true },
      },
    },
  });
  if (!task) {
    return { taskId: job.taskId, outcome: "skipped" as const, note: "task no longer exists" };
  }
  const correlation = await validateFinalizationCorrelation(task, job);
  if (!correlation.ok) {
    await recordFinalizationCorrelationRejection({
      taskId: task.id,
      projectId: task.projectId,
      job,
      reason: correlation.reason,
    });
    return {
      taskId: task.id,
      outcome: "rejected-correlation" as const,
      note: correlation.reason,
    };
  }
  if (correlation.replay) {
    const replay = await applyExactFinalizationJobCallback({ job, taskId: task.id, ok: true });
    return replay.applied
      ? { taskId: task.id, outcome: "replayed" as const }
      : { taskId: task.id, outcome: "rejected-correlation" as const, note: replay.reason };
  }
  if (task.status !== "Review") {
    return { taskId: job.taskId, outcome: "skipped" as const, note: "task is no longer in Review" };
  }
  const repositoryPath = task.project.repositoryPath;
  const taskBranch = effectiveTaskBranchName(task);
  const repoTouched = task.repositoryRun?.repoTouched === true;
  const candidateSha = repoTouched
    ? task.repositoryRun?.candidateSha
    : task.repositoryRun?.baseSha;
  const monitor = await monitorAgentUser();
  if (!monitor) {
    await recordTaskReviewOperationalError({
      taskId: task.id,
      error: "No active Monitor Agent is available to finalize the reviewed repository branch.",
      preserveValidationOutcome: true,
    });
    const callback = await applyExactFinalizationJobCallback({
      job,
      taskId: task.id,
      ok: false,
      error: "No active Monitor Agent is available to finalize the reviewed repository branch.",
    });
    return callback.applied
      ? { taskId: task.id, outcome: "operational-error" as const }
      : { taskId: task.id, outcome: "rejected-correlation" as const, note: callback.reason };
  }
  const actor = { id: monitor.id, username: monitor.username, kind: "agent" as const };

  const fail = async (reason: string, operational = false) => {
    if (operational) {
      const attempt = job.attempt ?? 0;
      await recordTaskReviewOperationalError({
        taskId: task.id,
        actor,
        error: reason,
        preserveValidationOutcome: true,
        retryPending: attempt < 2,
      });
      if (attempt < 2) {
        await enqueueEpicMergeJob({
          ...job,
          attempt: attempt + 1,
          enqueuedAt: new Date().toISOString(),
        }, { allowWhileRunning: true });
        return {
          taskId: task.id,
          outcome: "operational-retry" as const,
          reason,
          attempt: attempt + 1,
        };
      }
      await db.comment.create({
        data: {
          taskId: task.id,
          userId: actor.id,
          body: `⚙️ Repository finalization could not complete after three attempts. The task remains in Review.\n\n${reason}`,
          commentKind: "workflow_action",
          isGenerated: true,
        },
      });
      const callback = await applyExactFinalizationJobCallback({ job, taskId: task.id, ok: false, error: reason });
      if (!callback.applied) {
        return { taskId: task.id, outcome: "rejected-correlation" as const, note: callback.reason };
      }
      return { taskId: task.id, outcome: "operational-error" as const, reason, attempt };
    }
    await recordTaskReviewOperationalError({
      taskId: task.id, actor, error: reason, preserveValidationOutcome: true,
    });
    await db.comment.create({
      data: {
        taskId: task.id,
        userId: actor.id,
        body: `🚫 Repository finalization failed. The task remains in Review with its accepted candidate preserved. Resolve the reported problem before retrying finalization.\n\n${reason}`,
        commentKind: "workflow_action",
        isGenerated: true,
      },
    });
    const callback = await applyExactFinalizationJobCallback({ job, taskId: task.id, ok: false, error: reason });
    if (!callback.applied) {
      return { taskId: task.id, outcome: "rejected-correlation" as const, note: callback.reason };
    }
    return { taskId: task.id, outcome: "callback-applied" as const, reason };
  };

  if (!candidateSha || job.candidateSha !== candidateSha || task.repositoryRun?.reviewedSha !== job.candidateSha) {
    return fail(
      `Finalization job candidate ${job.candidateSha} no longer matches the reviewer-approved repository candidate ${task.repositoryRun?.reviewedSha ?? "none"}.`,
    );
  }

  if (!repositoryPath || !taskBranch || !candidateSha) {
    return fail("The validated repository path, task branch, or candidate SHA is missing.");
  }
  const finalizedRepositoryPath = repositoryPath;
  const finalizedTaskBranch = taskBranch;
  const validatedCandidateSha = candidateSha;
  const finalizedWorktreePath = task.repositoryRun?.worktreePath;

  // The review decision is a lease on one immutable candidate, not permission
  // to merge whatever happens to be in the task worktree later. Re-check the
  // registered worktree immediately before every cleanup/merge/publish path.
  // A dirty tree, branch switch, or new commit invalidates the review and must
  // return to the assignee; treating it as an operational retry would keep
  // retrying a candidate that no reviewer ever approved.
  if (!finalizedWorktreePath) {
    return fail("The validated candidate has no registered task worktree.");
  }
  const candidateInspection = await inspectValidatedCandidateWorktree({
    worktreePath: finalizedWorktreePath,
    taskBranch: finalizedTaskBranch,
    candidateSha: validatedCandidateSha,
  });
  if (!candidateInspection.ok) {
    return fail(
      candidateInspection.reason,
      isOperationalRepositoryFailure(candidateInspection.reason),
    );
  }

  if (!repoTouched) {
    const noChangeEpicBranch = task.epic ? effectiveEpicBranchName(task.epic) : null;
    const cleanup = await removeFinalizedTaskWorktree(finalizedRepositoryPath, finalizedTaskBranch, noChangeEpicBranch
      ? [noChangeEpicBranch]
      : []);
    if (!cleanup.ok) return fail(cleanup.error, true);
  } else if (task.epic) {
    const epicBranch = effectiveEpicBranchName(task.epic);
    if (!epicBranch) return fail("The Epic integration branch cannot be resolved.");
    const candidateAlreadyMerged = task.activity.some((activity) => {
      try {
        return typeof activity.payload === "string" &&
          JSON.parse(activity.payload).candidateSha === validatedCandidateSha;
      } catch {
        return false;
      }
    });
    if (!candidateAlreadyMerged) {
      const result = await publishWithDevLease({ projectId: task.projectId, taskId: task.id, repositoryPath: finalizedRepositoryPath, branch: epicBranch, attemptId: job.jobId, publish: async beforePush => mergeTaskBranchIntoEpic({
        beforePush, repoPath: finalizedRepositoryPath,
        epicBranch,
        taskBranch: finalizedTaskBranch,
        baseBranch: await productionBranchFor(task.projectId),
        gitUserName: task.project.defaultGitUserName?.trim() || "PM Monitor",
        gitUserEmail: task.project.defaultGitUserEmail?.trim() || "pm-monitor@localhost",
        message: `Merge ${task.workItemKey ?? taskBranch} into Epic branch ${epicBranch}`,
      }) });
      if (!result.ok) {
        if ("deferred" in result && result.deferred) return { taskId: task.id, outcome: "deferred" as const, reason: result.reason };
        return fail(result.reason, isOperationalRepositoryFailure(result.reason));
      }
      await db.activityLog.create({
        data: {
          projectId: task.projectId,
          taskId: task.id,
          userId: actor.id,
          kind: "pm.epic.merge.ok",
          payload: JSON.stringify({
            taskId: task.id,
            epicId: task.epic.id,
            epicBranch,
            taskBranch: finalizedTaskBranch,
            kind: result.kind,
            candidateSha: validatedCandidateSha,
          }),
        },
      });
    }
    await runGitOk(finalizedRepositoryPath, [
      "fetch",
      "--quiet",
      "origin",
      `+refs/heads/${epicBranch}:refs/remotes/origin/${epicBranch}`,
    ], { timeout: 60_000 });
    const contained = await runGitOk(finalizedRepositoryPath, [
      "merge-base",
      "--is-ancestor",
      validatedCandidateSha,
      `refs/remotes/origin/${epicBranch}`,
    ]);
    if (!contained) {
      return fail(`Validated commit ${validatedCandidateSha} is not contained in the published Epic branch ${epicBranch}.`);
    }
    const cleanup = await removeFinalizedTaskWorktree(finalizedRepositoryPath, finalizedTaskBranch, [epicBranch]);
    if (!cleanup.ok) return fail(cleanup.error, true);
  } else {
    const remote = await inspectOriginBranch(finalizedRepositoryPath, finalizedTaskBranch);
    if (!remote.ok) return fail(remote.reason, isOperationalRepositoryFailure(remote.reason));
    if (!remote.sha || remote.sha !== validatedCandidateSha) {
      return fail(
        `origin/${finalizedTaskBranch} is ${remote.sha ?? "missing"}; expected validated commit ${validatedCandidateSha}.`,
      );
    }
    const cleanup = await removeFinalizedTaskWorktree(finalizedRepositoryPath, finalizedTaskBranch, []);
    if (!cleanup.ok) return fail(cleanup.error, true);
  }

  const callback = await applyExactFinalizationJobCallback({
    job,
    taskId: task.id,
    ok: true,
  });
  if (!callback.applied) {
    return { taskId: task.id, outcome: "rejected-correlation" as const, note: callback.reason };
  }
  publishBoardTouch(task.projectId);
  return { taskId: task.id, outcome: "callback-applied" as const };
}

function renderCleanupBody(job: Extract<EpicMergeJob, { kind: "cleanup" }>, items: CleanupItem[]) {
  const removed = items.filter((item) => item.outcome === "removed");
  const absent = items.filter((item) => item.outcome === "absent");
  const failed = items.filter((item) => item.outcome === "failed");
  const needsRoot = items.filter((item) => item.outcome === "needs-root");
  const remoteRemoved = items.filter((item) => item.remoteOutcome === "removed");
  const remoteFailed = items.filter((item) => item.remoteOutcome === "failed");
  const lines = [
    `🧹 Epic is Done — Epic branch \`${job.epicBranch}\` is published and child-branch cleanup is complete.`,
    "",
  ];
  if (removed.length > 0) {
    lines.push(`- Removed (worktree + local branch): ${removed.map((item) => `\`${item.branch}\``).join(", ")}`);
  }
  if (absent.length > 0) {
    lines.push(`- Already absent locally: ${absent.map((item) => `\`${item.branch}\``).join(", ")}`);
  }
  for (const item of failed) {
    lines.push(`- Failed: \`${item.branch}\` — ${item.detail}`);
  }
  for (const item of needsRoot) {
    lines.push(`- Needs root (likely ACL/permission breakage): \`${item.branch}\` — ${item.detail}`);
  }
  if (remoteRemoved.length > 0) {
    lines.push(
      `- Removed leaked remote task refs after ancestry verification: ${remoteRemoved.map((item) => `\`origin/${item.branch}\``).join(", ")}`,
    );
  }
  for (const item of remoteFailed) {
    lines.push(`- Remote ref preserved: \`origin/${item.branch}\` — ${item.remoteDetail}`);
  }
  lines.push("", `The Epic integration branch \`${job.epicBranch}\` is the published origin record.`);
  return lines.join("\n");
}

async function executeCleanupJob(job: Extract<EpicMergeJob, { kind: "cleanup" }>) {
  const epic = await db.epic.findUnique({
    where: { id: job.epicId },
    select: { id: true, status: true, projectId: true },
  });
  if (!epic || epic.status !== "Done") {
    return { epicId: job.epicId, outcome: "skipped" as const, note: "epic no longer Done" };
  }

  // Whole-Epic acceptance normally proves every child merge before Done. Keep
  // this guard for legacy/manual records and recovery races: cleanup never
  // outruns an unrecorded child integration.
  const pendingMerges = await db.task.count({
    where: {
      epicId: job.epicId,
      parentTaskId: null,
      deletedAt: null,
      status: "Done",
      repositoryRun: { is: { repoTouched: true } },
      activity: { none: { kind: "pm.epic.merge.ok" } },
    },
  });
  if (pendingMerges > 0) {
    return { epicId: job.epicId, outcome: "deferred" as const, note: `${pendingMerges} child merge(s) still pending` };
  }

  // Finalization invariant: an Epic cannot remain Done unless its integration
  // branch is published. This covers manual Epic-Done transitions and legacy
  // local-only integrations in addition to the normal per-child eager pushes.
  const publish = await publishWithDevLease({ projectId: job.projectId, repositoryPath: job.repositoryPath, branch: job.epicBranch, attemptId: job.jobId, publish: beforePush => publishEpicBranch({
    beforePush, repoPath: job.repositoryPath,
    epicBranch: job.epicBranch,
  }) });
  if (!publish.ok) {
    if ("deferred" in publish && publish.deferred) return { epicId: job.epicId, outcome: "deferred" as const, reason: publish.reason };
    const monitor = await monitorAgentUser();
    const now = new Date();
    const body = [
      `🚫 Epic branch \`${job.epicBranch}\` could not be published, so the Epic is back in Review.`,
      "",
      publish.reason,
      "",
      "Resolve the Git/ref problem, then move the Epic to Done again. PM will retry publication before cleaning any child branches.",
    ].join("\n");
    await db.$transaction(async (tx) => {
      await tx.epic.update({
        where: { id: job.epicId },
        data: {
          status: "Review",
          statusChangedAt: now,
          completionReviewStatus: "Operational Error",
          completionReviewLastError: publish.reason.slice(0, 4000),
        },
      });
      if (monitor) {
        await tx.comment.create({ data: { epicId: job.epicId, userId: monitor.id, body, commentKind: "workflow_action", isGenerated: true } });
      }
      await tx.activityLog.create({
        data: {
          projectId: job.projectId,
          userId: monitor?.id ?? null,
          kind: "epic.status",
          payload: JSON.stringify({
            epicId: job.epicId,
            from: "Done",
            to: "Review",
            via: "epic_publish_failed",
          }),
        },
      });
      await tx.activityLog.create({
        data: {
          projectId: job.projectId,
          userId: monitor?.id ?? null,
          kind: "pm.epic.publish.fail",
          payload: JSON.stringify({
            epicId: job.epicId,
            epicBranch: job.epicBranch,
            reason: publish.reason,
          }),
        },
      });
    });
    publishBoardTouch(job.projectId);
    return {
      epicId: job.epicId,
      outcome: "publish-failed" as const,
      reason: publish.reason,
    };
  }

  // Refresh the pushed Epic ref: it is the merge record every local or leaked
  // remote child deletion is verified against.
  await runGitOk(job.repositoryPath, [
    "fetch",
    "--quiet",
    "origin",
    `+refs/heads/${job.epicBranch}:refs/remotes/origin/${job.epicBranch}`,
  ], { timeout: 60_000 });

  const items: CleanupItem[] = [];
  for (const branch of job.branches) {
    const remote = await removeMergedOriginChildBranch({
      repoPath: job.repositoryPath,
      epicBranch: job.epicBranch,
      taskBranch: branch,
    });
    const local = await removeLocalBranch(job, branch);
    items.push({
      ...local,
      remoteOutcome: remote.outcome,
      remoteDetail: remote.detail,
    });
  }

  const monitor = await monitorAgentUser();
  const body = renderCleanupBody(job, items);
  await db.$transaction(async (tx) => {
    if (monitor) {
      await tx.comment.create({ data: { epicId: job.epicId, userId: monitor.id, body, commentKind: "workflow_action", isGenerated: true } });
    }
    await tx.activityLog.create({
      data: {
        projectId: job.projectId,
        userId: monitor?.id ?? null,
        kind: "pm.epic.cleanup",
        payload: JSON.stringify({
          epicId: job.epicId,
          epicBranch: job.epicBranch,
          publish,
          items,
        }),
      },
    });
    await tx.activityLog.create({
      data: {
        projectId: job.projectId,
        userId: monitor?.id ?? null,
        kind: "pm.epic.publish.ok",
        payload: JSON.stringify({
          epicId: job.epicId,
          epicBranch: job.epicBranch,
          kind: publish.kind,
          sha: publish.sha,
        }),
      },
    });
  });
  publishBoardTouch(job.projectId);

  return { epicId: job.epicId, outcome: "done" as const, items };
}

async function executeHardResetJob(job: Extract<EpicMergeJob, { kind: "reset" }>) {
  const task = await db.task.findUnique({
    where: { id: job.taskId, deletedAt: null },
    select: {
      id: true,
      projectId: true,
      workItemKey: true,
      branchName: true,
      status: true,
      assigneeId: true,
      actingManagerId: true,
      project: {
        select: {
          repositoryPath: true,
          deploymentProductionBranch: true,
          deploymentPrTargetBranch: true,
          agentChangeBlockedBranches: true,
        },
      },
      epic: { select: { workItemKey: true, branchName: true } },
      repositoryRun: { select: { repositoryPath: true, branchName: true } },
      activity: {
        where: { kind: "task.reset.requested" },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { payload: true },
      },
    },
  });
  if (!task || task.projectId !== job.projectId) {
    throw new Error("Task hard reset target no longer exists in the expected project.");
  }
  let requestedToken = "";
  try {
    requestedToken = String((JSON.parse(task.activity[0]?.payload ?? "{}") as { resetToken?: unknown }).resetToken ?? "");
  } catch {
    requestedToken = "";
  }
  if (requestedToken !== job.resetToken) {
    throw new Error("Task hard reset request was superseded before repository cleanup.");
  }
  if (task.status !== "Backlog" || task.assigneeId || task.actingManagerId) {
    throw new Error("Task hard reset lost its quiesced Backlog fence.");
  }

  const repositoryPath = task.repositoryRun?.repositoryPath ?? task.project.repositoryPath;
  const branchName = task.repositoryRun?.branchName ?? effectiveTaskBranchName(task);
  if (repositoryPath !== job.repositoryPath || branchName !== job.branchName) {
    throw new Error("Task repository identity changed while hard reset was pending.");
  }

  if (repositoryPath && branchName) {
    const peers = await db.task.findMany({
      where: {
        id: { not: task.id },
        projectId: task.projectId,
        deletedAt: null,
        archivedAt: null,
        status: { not: "Done" },
      },
      select: {
        workItemKey: true,
        branchName: true,
        epic: { select: { workItemKey: true, branchName: true } },
        repositoryRun: { select: { branchName: true } },
      },
    });
    const shared = peers.some((peer) => (
      (peer.repositoryRun?.branchName ?? effectiveTaskBranchName(peer)) === branchName
    ));
    if (shared) {
      throw new Error(`Refused to discard shared task branch ${branchName}.`);
    }
    const protectedBranches = localWorktreeProtectedBranches(task.project);
    const epicBranch = task.epic ? effectiveEpicBranchName(task.epic) : null;
    if (epicBranch) protectedBranches.push(epicBranch);
    const activeBranch = await activeRunnerBranchForRepository(repositoryPath);
    if (activeBranch) protectedBranches.push(activeBranch);
    try {
      await exec(
        "python3",
        [
          worktreeRemoveScript(),
          "--discard-branch",
          repositoryPath,
          `${repositoryPath}.worktrees`,
          branchName,
          JSON.stringify(protectedBranches),
        ],
        { timeout: 60_000, maxBuffer: 1024 * 1024 },
      );
    } catch (err) {
      const anyErr = err as { stderr?: string; stdout?: string; message?: string };
      const detail = String(anyErr.stderr || anyErr.stdout || anyErr.message || err).trim().slice(0, 800);
      throw new Error(`Task hard reset could not discard the local worktree/branch: ${detail}`);
    }
  }

  const result = await purgeTaskHardResetState({
    taskId: task.id,
    resetToken: job.resetToken,
    actorUserId: job.requestedByUserId,
    stoppedAgents: job.stoppedAgents,
    repositoryPath,
    branchName,
  });
  publishBoardTouch(task.projectId);
  return result;
}

export async function runEpicMergeSpoolJob(job: EpicMergeJob) {
  if (job.kind === "merge") return executeMergeJob(job);
  if (job.kind === "finalize") return executeFinalizeJob(job);
  if (job.kind === "checkpoint") return executeCheckpointJob(job);
  if (job.kind === "reset") return executeHardResetJob(job);
  if (job.kind === "review") return executeCompletionReviewJob(job);
  if (job.kind === "review-approval") return executeCompletionReviewApprovalJob(job);
  return executeCleanupJob(job);
}
