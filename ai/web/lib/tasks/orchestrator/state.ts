// ORCH-02b — Task aggregate loading and transaction-time fencing.
//
// This module owns the complete task aggregate (spec §8) and the
// transaction-time state refresh + fencing helpers that re-read and
// re-validate authoritative state inside executeWorkflowCommand's
// transaction.
//
// Domain error codes are declared locally as FENCE_ERROR_CODES so this module
// builds against the current phase-e tip without depending on PHASEE-02a's
// DOMAIN_ERROR_CODES in types.ts. The string literals are identical to 02a's
// list so the import can be re-pointed after 02a merges without changing
// call sites.
//
// Invariants enforced:
//   2. Optimistic concurrency — fenceState re-reads workflowVersion inside
//      the transaction and rejects stale commands.
//   5. One open cycle — fenceState verifies the active cycle matches.
//   8. Immutable review decision — fenceState verifies lease status/identity.
//   6. One active procedure per type/cycle — fenceState checks uniqueness.
//
// No edits to types.ts, command-schema.ts, or normalize.ts (PHASEE-02a owns
// those).

import { canRetryAcceptedRepositoryReview } from "@/lib/tasks/repository-finalization";
import type { Prisma } from "@prisma/client";
import type { TaskWorkflowCommand } from "@/lib/tasks/orchestrator/types";
import type { TaskStateSnapshot } from "@/lib/tasks/orchestrator/types";
import { resolveReviewOwnerId } from "@/lib/tasks/workflow-actors";
import { activeFormalBlockerStatesByTask } from "@/lib/tasks/formal-blocker";
import { effectiveTaskBranchName } from "@/lib/work-items/branches";
import { findInProgressStartConflict } from "@/lib/tasks/start-conflict";
import { acceptanceChecklistSnapshot } from "@/lib/tasks/acceptance";
import { resolvePermissionReviewerId } from "@/lib/tasks/permission-reviewer";

// ---------------------------------------------------------------------------
// FENCE_ERROR_CODES — local declaration, structurally assignable to 02a's
// DOMAIN_ERROR_CODES. String literals MUST stay identical so the post-02a
// re-point is a one-line import swap with no call-site churn.
// ---------------------------------------------------------------------------

export const FENCE_ERROR_CODES = [
  "stale_version",
  "cycle_mismatch",
  "lease_mismatch",
  "candidate_mismatch",
  "idempotency_conflict",
] as const;

export type FenceErrorCode = (typeof FENCE_ERROR_CODES)[number];

// ---------------------------------------------------------------------------
// FenceResult — returned by fenceState. On success, ok=true. On failure,
// ok=false and the code identifies which invariant was violated, with
// expected vs actual values so the caller can produce a descriptive error.
// ---------------------------------------------------------------------------

export type FenceResult =
  | { ok: true }
  | {
      ok: false;
      code: FenceErrorCode;
      expected: string;
      actual: string;
    };

// ---------------------------------------------------------------------------
// TaskAggregate — the complete authoritative state snapshot (spec §8).
//
// This extends TaskStateSnapshot with every additional field the Phase E
// guards require. The existing guards/decide/authorize functions consume
// TaskStateSnapshot, so TaskAggregate is structurally compatible — the
// extra fields are available to new guards without breaking old ones.
// ---------------------------------------------------------------------------

export type TaskAggregate = TaskStateSnapshot & {
  // --- Task extended fields ---
  rank: number;
  alertReporter: boolean;
  archivedAt: Date | null;
  workflowEngine: string;
  workflowEnginePinnedAt: Date | null;
  branchName: string | null;
  commitPrefix: string | null;

  // --- Project extended fields ---
  project: TaskStateSnapshot["project"] & {
    slug: string;
    name: string;
    defaultAssigneeId: string | null;
    defaultReviewerId: string | null;
  };

  // --- Epic extended fields ---
  epic: (TaskStateSnapshot["epic"] & {
    id: string;
    branchName: string | null;
    commitPrefix: string | null;
    completionReviewStatus: string;
    deploymentStatus: string;
  }) | null;

  // --- Unresolved prerequisites ---
  unresolvedPrerequisites: Array<{
    id: string;
    title: string;
    status: string;
  }>;

  // --- Assignee role/capabilities ---
  assignee: {
    id: string;
    username: string | null;
    kind: string;
    codingCapability: boolean;
  } | null;

  // --- Other In Progress task for same assignee/project ---
  otherInProgressTaskForAssignee: {
    id: string;
    title: string;
  } | null;

  // --- Other In Progress task on same effective branch ---
  otherInProgressTaskOnBranch: {
    id: string;
    title: string;
    branchName: string | null;
  } | null;

  // --- Structured Action Plan ---
  actionPlan: {
    id: string;
    version: number;
    status: string;
    approvedOn: Date | null;
    approvedById: string | null;
    authorId: string | null;
    sourceRunId: string | null;
    sourceMessageId: string | null;
    reviewedAt?: Date | null;
    reviewedById?: string | null;
    delegatedApproverId?: string | null;
    delegatedById?: string | null;
    contentHash: string;
    steps: Array<{
      id: string;
      stepId: string;
      title: string;
      kind: string;
      assigneeId: string | null;
      rank: number;
    }>;
  } | null;

  // --- Open checklist ---
  openChecklist: {
    count: number;
    ids: string[];
  };
  openReviewChecklist: { count: number; ids: string[] };

  // --- Active formal blocker + permission-round state ---
  activeBlocker: {
    commentId: string | null;
    raisedAt: Date | null;
    report: {
      blockedOn: string;
      requestedActor: string;
      requestedAction: string;
      evidence: string;
      diagnosticsAttempted: string[];
      resumeCondition: string;
      reporterCanResolve: boolean;
    } | null;
    permissionRequest: import("@/lib/tasks/formal-blocker").BlockerPermissionRequest | null;
    permissionGrant: {
      authorizationCommentId: string | null;
      grantedAt: Date | null;
    } | null;
    override: {
      kind: "wait_for_human";
      targetStatus: string | null;
      reason: string | null;
    } | null;
  } | null;

  // --- Active cycle + engine owner ---
  activeCycle: {
    id: string;
    sequence: number;
    status: string;
    workflowEngine: string;
    openedWorkflowVersion: number;
    baseSha: string | null;
    candidateSha: string | null;
  } | null;

  // --- Active procedure runs + blocking statuses ---
  activeProcedureRuns: Array<{
    id: string;
    type: string;
    status: string;
    workflowCycleId: string | null;
  }>;

  // --- Repository run extended ---
  repositoryRun: (TaskStateSnapshot["repositoryRun"] & {
    id: string;
    repositoryPath: string | null;
    branchName: string | null;
    worktreePath: string | null;
    epicBranch: string | null;
    version: number;
    attempt: number;
    lastError: string | null;
    validationOutcome: string | null;
  }) | null;

  // --- Active review lease extended ---
  activeReviewRun: (NonNullable<TaskStateSnapshot["activeReviewRun"]> & {
    baseSha: string | null;
    repoTouched: boolean;
    validationOutcome: string;
  }) | null;

  // --- PM-channel run + episode state ---
  pmChannelRun: {
    id: string;
    status: string;
    agentSlug: string;
    messageId: string;
    disposition: string | null;
    settledByAction: string | null;
  } | null;

  activeEpisode: {
    id: string;
    episodeNo: number;
    status: string;
    cycleCount: number;
    cycleBudget: number;
    exhaustedByMessageId: string | null;
    barrierReleasedAt: Date | null;
  } | null;

  // --- Outstanding validation/finalization jobs ---
  outstandingJobs: Array<{
    id: string;
    kind: string;
    status: string;
    procedureRunId: string | null;
  }>;
};

// ---------------------------------------------------------------------------
// Prisma client type alias for transaction client.
// ---------------------------------------------------------------------------

type DbClient = Prisma.TransactionClient;

// ---------------------------------------------------------------------------
// loadTaskAggregate — loads the full aggregate from db in one round of
// queries. This is the pre-transaction snapshot used by guards/decide/authorize.
// ---------------------------------------------------------------------------

export async function loadTaskAggregate(taskId: string): Promise<TaskAggregate | null> {
  return loadTaskAggregateWithClient(undefined, taskId, false);
}

// ---------------------------------------------------------------------------
// refreshTaskAggregateForTx — re-reads the same fields inside a Prisma
// transaction client. Used by fenceState and any transaction-time check.
// ---------------------------------------------------------------------------

export async function refreshTaskAggregateForTx(
  tx: DbClient,
  taskId: string,
): Promise<TaskAggregate | null> {
  return loadTaskAggregateWithClient(tx, taskId, true);
}

// ---------------------------------------------------------------------------
// Internal: shared loader. When useTx=true, uses the transaction client;
// otherwise uses the global db client.
// ---------------------------------------------------------------------------

async function loadTaskAggregateWithClient(
  tx: DbClient | undefined,
  taskId: string,
  useTx: boolean,
): Promise<TaskAggregate | null> {
  // We need to use either the tx client or the global db. When useTx is false,
  // tx is undefined — we import db lazily.
  const client = useTx
    ? tx!
    : (await import("@/lib/db")).db;

  const task = await client.task.findUnique({
    where: { id: taskId, deletedAt: null },
    select: {
      id: true,
      status: true,
      workflowVersion: true,
      projectId: true,
      epicId: true,
      reviewAttachmentRequired: true,
      assigneeId: true,
      actingManagerId: true,
      reporterId: true,
      approvedOn: true,
      approvedById: true,
      activeWorkflowCycleId: true,
      rank: true,
      alertReporter: true,
      archivedAt: true,
      workflowEngine: true,
      workflowEnginePinnedAt: true,
      workItemKey: true,
      branchName: true,
      commitPrefix: true,
      project: {
        select: {
          id: true,
          slug: true,
          name: true,
          onlyReportersCanApproveActionPlans: true,
          onlyReportersCanSetTasksDone: true,
          workMode: true,
          repositoryPath: true,
          defaultAssigneeId: true,
          defaultReviewerId: true,
        },
      },
      epic: {
        select: {
          id: true,
          workItemKey: true,
          status: true,
          actingManagerId: true,
          branchName: true,
          commitPrefix: true,
          approvedOn: true,
          completionReviewStatus: true,
          deploymentStatus: true,
        },
      },
      repositoryRun: {
        select: {
          id: true,
          phase: true,
          candidateSha: true,
          baseSha: true,
          repoTouched: true,
          reviewedSha: true,
          repositoryPath: true,
          branchName: true,
          worktreePath: true,
          epicBranch: true,
          version: true,
          attempt: true,
          lastError: true,
          validationOutcome: true,
        },
      },
      actionPlan: {
        select: {
          id: true,
          version: true,
          status: true,
          approvedOn: true,
          approvedById: true,
          authorId: true,
          sourceRunId: true,
          sourceMessageId: true,
          reviewedAt: true, reviewedById: true, delegatedApproverId: true, delegatedById: true,
          contentHash: true,
          steps: {
            select: {
              id: true,
              stepId: true,
              title: true,
              kind: true,
              assigneeId: true,
              rank: true,
            },
            orderBy: { rank: "asc" },
          },
        },
      },
      _count: { select: { attachments: true } },
    },
  });

  if (!task) return null;

  // --- Parallel queries for related data ---
  const [
    reviewRun,
    activeCycle,
    activeProcedures,
    openChecklist,
    openFindings,
    dependencies,
    assignee,
    pmChannelRun,
    activeEpisode,
    blockerActivityRows,
  ] = await Promise.all([
    // Active review run
    task.activeWorkflowCycleId
      ? client.reviewRun.findUnique({
          where: { workflowCycleId: task.activeWorkflowCycleId },
          select: {
            id: true,
            status: true,
            candidateSha: true,
            reviewerId: true,
            baseSha: true,
            repoTouched: true,
            validationOutcome: true,
            acceptancePlanVersion: true, acceptanceChecklistHash: true,
          },
        })
      : Promise.resolve(null),

    // Active cycle
    task.activeWorkflowCycleId
      ? client.taskWorkflowCycle.findUnique({
          where: { id: task.activeWorkflowCycleId },
          select: {
            id: true,
            sequence: true,
            status: true,
            workflowEngine: true,
            openedWorkflowVersion: true,
            baseSha: true,
            candidateSha: true,
          },
        })
      : Promise.resolve(null),

    // Active procedure runs
    client.taskProcedureRun.findMany({
      where: {
        taskId: taskId,
        status: { in: ["queued", "running"] },
      },
      select: {
        id: true,
        type: true,
        status: true,
        workflowCycleId: true,
      },
    }),

    // Open implementation and review checklists have different gates.
    client.subTask.findMany({
      where: {
        taskId: taskId,
        completedAt: null,
      },
      select: { id: true, kind: true, responsibleActor: true, acceptanceGate: true },
    }),

    client.reviewFinding.findMany({ where: { taskId, status: "open" }, select: { id: true, subTaskId: true } }),

    // Unresolved prerequisites (via TaskDependency)
    client.taskDependency.findMany({
      where: { taskId: taskId },
      select: {
        prerequisite: {
          select: { id: true, title: true, status: true },
        },
      },
    }),

    // Assignee
    task.assigneeId
      ? client.user.findUnique({
          where: { id: task.assigneeId },
          select: {
            id: true,
            username: true,
            kind: true,
            status: true,
            agent: { select: { role: true, deactivatedAt: true } },
          },
        })
      : Promise.resolve(null),

    // Active PM channel run for this task
    client.pmChannelRun.findFirst({
      where: {
        taskId: taskId,
        status: { in: ["queued", "accepted", "streaming"] },
      },
      select: {
        id: true,
        status: true,
        agentSlug: true,
        messageId: true,
        disposition: true,
        settledByAction: true,
      },
      orderBy: { createdAt: "desc" },
    }),

    // Active execution episode
    client.taskExecutionEpisode.findFirst({
      where: {
        taskId: taskId,
        status: "open",
      },
      select: {
        id: true,
        episodeNo: true,
        status: true,
        cycleCount: true,
        cycleBudget: true,
        exhaustedByMessageId: true,
        barrierReleasedAt: true,
      },
      orderBy: { episodeNo: "desc" },
    }),

    // Formal blocker activity rows (newest first) for active-blocker resolution.
    client.activityLog.findMany({
      where: {
        taskId: taskId,
        kind: {
          in: [
            "task.blocker",
            "task.extra_work.blocker",
            "task.blocker.cleared",
            "task.blocker.permission.granted",
          ],
        },
      },
      select: {
        taskId: true,
        kind: true,
        payload: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  // --- Shared WIP/effective-branch start gate ---
  // This is the same resolver used by auto-start before it submits the
  // canonical command. In particular, an Epic child with no explicit
  // branchName resolves from its own work-item key before the Epic fallback.
  const effectiveBranch = effectiveTaskBranchName(task);
  const startConflict = await findInProgressStartConflict(client, {
    taskId,
    projectId: task.projectId,
    assigneeId: task.assigneeId,
    candidateBranch: effectiveBranch,
  });
  const otherInProgressForAssignee = startConflict?.kind === "wip"
    ? { id: startConflict.activeTask.id, title: startConflict.activeTask.title }
    : null;
  const otherInProgressOnBranch = startConflict?.kind === "branch"
    ? {
        id: startConflict.activeTask.id,
        title: startConflict.activeTask.title,
        branchName: effectiveBranch,
      }
    : null;

  // --- Outstanding validation/finalization jobs ---
  // These are procedure runs in waiting_callback status for validation/finalization.
  const outstandingJobs = activeProcedures
    .filter(
      (p) =>
        p.type === "submit_candidate_for_review" ||
        p.type === "finalize_accepted_review",
    )
    .map((p) => ({
      id: p.id,
      kind: p.type,
      status: p.status,
      procedureRunId: p.id,
    }));

  // --- Resolve review owner for snapshot compatibility ---
  const resolvedReviewOwnerId = resolveReviewOwnerId({
    actingManagerId: task.actingManagerId,
    reporterId: task.reporterId,
    epic: task.epic
      ? {
          status: task.epic.status,
          actingManagerId: task.epic.actingManagerId,
        }
      : null,
  });

  // --- Resolve the active formal blocker (including historical wait-for-human
  // markers and current permission/operational blockers) ------------------
  // clear_blocker writes task.blocker.cleared. The newest-first resolver
  // returns the active blocker for this task, which the relevant workflow
  // guards use until it is resolved.
  const activeBlocker = activeFormalBlockerStatesByTask(blockerActivityRows).get(taskId) ?? null;

  // --- Build the aggregate ---
  const aggregate: TaskAggregate = {
    // TaskStateSnapshot base fields
    id: task.id,
    status: task.status as TaskStateSnapshot["status"],
    workflowVersion: task.workflowVersion,
    projectId: task.projectId,
    epicId: task.epicId,
    reviewAttachmentRequired: task.reviewAttachmentRequired,
    attachmentCount: task._count.attachments,
    assigneeId: task.assigneeId,
    actingManagerId: task.actingManagerId,
    reporterId: task.reporterId,
    approvedOn: task.approvedOn,
    approvedById: task.approvedById,
    activeWorkflowCycleId: task.activeWorkflowCycleId,
    resolvedReviewOwnerId,
    resolvedPermissionReviewerId: await resolvePermissionReviewerId(task, client),

    // Extended task fields
    rank: task.rank,
    alertReporter: task.alertReporter,
    archivedAt: task.archivedAt,
    workflowEngine: task.workflowEngine,
    workflowEnginePinnedAt: task.workflowEnginePinnedAt,
    branchName: task.branchName,
    commitPrefix: task.commitPrefix,

    // Project
    project: {
      onlyReportersCanApproveActionPlans:
        task.project.onlyReportersCanApproveActionPlans,
      onlyReportersCanSetTasksDone: task.project.onlyReportersCanSetTasksDone,
      workMode: task.project.workMode,
      repositoryPath: task.project.repositoryPath,
      slug: task.project.slug,
      name: task.project.name,
      defaultAssigneeId: task.project.defaultAssigneeId,
      defaultReviewerId: task.project.defaultReviewerId,
    },

    // Epic
    epic: task.epic
      ? {
          status: task.epic.status,
          actingManagerId: task.epic.actingManagerId,
          approvedOn: task.epic.approvedOn,
          id: task.epic.id,
          branchName: task.epic.branchName,
          commitPrefix: task.epic.commitPrefix,
          completionReviewStatus: task.epic.completionReviewStatus,
          deploymentStatus: task.epic.deploymentStatus,
        }
      : null,

    // Unresolved prerequisites
    unresolvedPrerequisites: dependencies
      .filter((d) => d.prerequisite.status !== "Done")
      .map((d) => ({
        id: d.prerequisite.id,
        title: d.prerequisite.title,
        status: d.prerequisite.status,
      })),

    // Assignee
    assignee: assignee
      ? {
          id: assignee.id,
          username: assignee.username,
          kind: assignee.kind,
          codingCapability: assignee.status === "active"
            && assignee.kind === "agent"
            && assignee.agent?.role === "coding"
            && !assignee.agent.deactivatedAt,
        }
      : null,

    // Other In Progress for assignee
    otherInProgressTaskForAssignee: otherInProgressForAssignee,

    // Other In Progress on same branch
    otherInProgressTaskOnBranch: otherInProgressOnBranch,

    // Action Plan
    actionPlan: task.actionPlan
      ? {
          id: task.actionPlan.id,
          version: task.actionPlan.version,
          status: task.actionPlan.status,
          approvedOn: task.actionPlan.approvedOn,
          approvedById: task.actionPlan.approvedById,
          authorId: task.actionPlan.authorId,
          sourceRunId: task.actionPlan.sourceRunId,
          sourceMessageId: task.actionPlan.sourceMessageId,
          reviewedAt: task.actionPlan.reviewedAt, reviewedById: task.actionPlan.reviewedById,
          delegatedApproverId: task.actionPlan.delegatedApproverId, delegatedById: task.actionPlan.delegatedById,
          contentHash: task.actionPlan.contentHash,
          steps: task.actionPlan.steps.map((s) => ({
            id: s.id,
            stepId: s.stepId,
            title: s.title,
            kind: s.kind,
            assigneeId: s.assigneeId,
            rank: s.rank,
          })),
        }
      : null,

    // Open checklist
    openChecklist: {
      count: new Set([...openChecklist.filter(c => c.kind === "implementation" && c.responsibleActor !== "owner" && c.acceptanceGate === "task").map(c => c.id), ...openFindings.map(f => f.subTaskId ?? f.id)]).size,
      ids: [...new Set([...openChecklist.filter(c => c.kind === "implementation" && c.responsibleActor !== "owner" && c.acceptanceGate === "task").map(c => c.id), ...openFindings.map(f => f.subTaskId ?? f.id)])],
    },
    openReviewChecklist: {
      count: openChecklist.filter((c) => c.kind === "review" && c.responsibleActor !== "owner" && c.acceptanceGate === "task").length,
      ids: openChecklist.filter((c) => c.kind === "review" && c.responsibleActor !== "owner" && c.acceptanceGate === "task").map((c) => c.id),
    },
    openOwnerAcceptance: {
      count: openChecklist.filter(c => c.kind !== "superseded" && c.responsibleActor === "owner" && c.acceptanceGate === "task").length,
      ids: openChecklist.filter(c => c.kind !== "superseded" && c.responsibleActor === "owner" && c.acceptanceGate === "task").map(c => c.id),
    },
    acceptanceChecklistHash: (await acceptanceChecklistSnapshot(client, taskId)).checklistHash,

    // Active blocker (resolved from activity log — formal blocker state)
    activeBlocker: activeBlocker
      ? {
          commentId: activeBlocker.commentId,
          raisedAt: activeBlocker.raisedAt instanceof Date
            ? activeBlocker.raisedAt
            : activeBlocker.raisedAt != null
              ? new Date(activeBlocker.raisedAt)
              : null,
          report: activeBlocker.report,
          permissionRequest: activeBlocker.permissionRequest
            ? {
                ...activeBlocker.permissionRequest,
              }
            : null,
          permissionGrant: activeBlocker.permissionGrant
            ? {
                authorizationCommentId: activeBlocker.permissionGrant.authorizationCommentId,
                grantedAt: activeBlocker.permissionGrant.grantedAt instanceof Date
                  ? activeBlocker.permissionGrant.grantedAt
                  : activeBlocker.permissionGrant.grantedAt != null
                    ? new Date(activeBlocker.permissionGrant.grantedAt)
                    : null,
              }
            : null,
          override: activeBlocker.override,
        }
      : null,

    // Active cycle
    activeCycle: activeCycle
      ? {
          id: activeCycle.id,
          sequence: activeCycle.sequence,
          status: activeCycle.status,
          workflowEngine: activeCycle.workflowEngine,
          openedWorkflowVersion: activeCycle.openedWorkflowVersion,
          baseSha: activeCycle.baseSha,
          candidateSha: activeCycle.candidateSha,
        }
      : null,

    // Active procedure runs
    activeProcedureRuns: activeProcedures.map((p) => ({
      id: p.id,
      type: p.type,
      status: p.status,
      workflowCycleId: p.workflowCycleId,
    })),

    // Repository run
    repositoryRun: task.repositoryRun
      ? {
          phase: task.repositoryRun.phase,
          candidateSha: task.repositoryRun.candidateSha,
          baseSha: task.repositoryRun.baseSha,
          repoTouched: task.repositoryRun.repoTouched,
          reviewedSha: task.repositoryRun.reviewedSha,
          id: task.repositoryRun.id,
          repositoryPath: task.repositoryRun.repositoryPath,
          branchName: task.repositoryRun.branchName,
          worktreePath: task.repositoryRun.worktreePath,
          epicBranch: task.repositoryRun.epicBranch,
          version: task.repositoryRun.version,
          attempt: task.repositoryRun.attempt,
          lastError: task.repositoryRun.lastError,
          validationOutcome: task.repositoryRun.validationOutcome,
        }
      : null,

    // Active review run
    activeReviewRun: reviewRun
      ? {
          id: reviewRun.id,
          status: reviewRun.status,
          candidateSha: reviewRun.candidateSha,
          reviewerId: reviewRun.reviewerId,
          baseSha: reviewRun.baseSha,
          repoTouched: reviewRun.repoTouched,
          validationOutcome: reviewRun.validationOutcome,
          acceptancePlanVersion: reviewRun.acceptancePlanVersion, acceptanceChecklistHash: reviewRun.acceptanceChecklistHash,
        }
      : null,

    // PM channel run
    pmChannelRun: pmChannelRun
      ? {
          id: pmChannelRun.id,
          status: pmChannelRun.status,
          agentSlug: pmChannelRun.agentSlug,
          messageId: pmChannelRun.messageId,
          disposition: pmChannelRun.disposition,
          settledByAction: pmChannelRun.settledByAction,
        }
      : null,

    // Active episode
    activeEpisode: activeEpisode
      ? {
          id: activeEpisode.id,
          episodeNo: activeEpisode.episodeNo,
          status: activeEpisode.status,
          cycleCount: activeEpisode.cycleCount,
          cycleBudget: activeEpisode.cycleBudget,
          exhaustedByMessageId: activeEpisode.exhaustedByMessageId,
          barrierReleasedAt: activeEpisode.barrierReleasedAt,
        }
      : null,

    // Outstanding jobs
    outstandingJobs,
  };

  return aggregate;
}

// ---------------------------------------------------------------------------
// fenceState — transaction-time state refresh and fencing.
//
// Re-reads the authoritative state inside the transaction and verifies that
// the command's expectations still hold. This is the authoritative check;
// the pre-transaction snapshot load remains for guard/decision purity, but
// the transaction-time fence is what prevents stale writes.
//
// Checks:
//   1. workflowVersion matches command.expectedWorkflowVersion
//   2. status matches what the decision expected (from state)
//   3. active cycle matches command.workflowCycleId (when provided)
//   4. lease status/identity matches (for review intents)
//   5. repository candidate SHA matches (for accept_review)
//   6. Action Plan revision matches (when relevant)
//   7. No duplicate active procedure of the same type for this cycle
// ---------------------------------------------------------------------------

export async function fenceState(
  tx: DbClient,
  taskId: string,
  command: TaskWorkflowCommand,
  preTransactionState: TaskStateSnapshot,
): Promise<FenceResult> {
  // Re-read the full aggregate inside the transaction via the shared loader.
  const aggregate = await refreshTaskAggregateForTx(tx, taskId);

  if (!aggregate) {
    return {
      ok: false,
      code: "stale_version",
      expected: "task exists",
      actual: "task not found or deleted",
    };
  }

  // 1. Workflow version check (invariant 2: optimistic concurrency)
  if (aggregate.workflowVersion !== command.expectedWorkflowVersion) {
    return {
      ok: false,
      code: "stale_version",
      expected: `workflowVersion=${command.expectedWorkflowVersion}`,
      actual: `workflowVersion=${aggregate.workflowVersion}`,
    };
  }

  // Checkboxes may change without bumping workflowVersion. Recheck their
  // gate and immutable verdict binding under the same write transaction.
  if (command.intent === "accept_review" || command.intent === "repository_finalization_succeeded") {
    const pending = aggregate.openChecklist.count + aggregate.openReviewChecklist.count
      + (command.intent === "repository_finalization_succeeded" ? aggregate.openOwnerAcceptance?.count ?? 0 : 0);
    if (pending) return { ok: false, code: "stale_version", expected: "all required acceptance checks complete", actual: `${pending} pending checks` };
    const review = aggregate.activeReviewRun;
    if (command.intent === "repository_finalization_succeeded" && review?.acceptanceChecklistHash &&
        (review.acceptanceChecklistHash !== aggregate.acceptanceChecklistHash || review.acceptancePlanVersion !== (aggregate.actionPlan?.version ?? 0))) {
      return { ok: false, code: "lease_mismatch", expected: "same accepted plan and checklist", actual: "acceptance criteria changed" };
    }
  }

  // 2. Status check — the status must not have changed between snapshot and
  //    transaction. The decision was computed from preTransactionState.status;
  //    if the task moved, the decision is invalid.
  if (aggregate.status !== preTransactionState.status) {
    return {
      ok: false,
      code: "stale_version",
      expected: `status=${preTransactionState.status}`,
      actual: `status=${aggregate.status}`,
    };
  }

  // 3. Engine owner check — a concurrent engine-ownership flip must not pass
  //    the fence. TaskStateSnapshot doesn't carry workflowEngine, so we compare
  //    the aggregate's task-level workflowEngine against the active cycle's
  //    frozen workflowEngine (set at cycle open time). If they diverge, an
  //    engine-ownership change occurred between snapshot and transaction.
  if (aggregate.activeCycle && aggregate.activeCycle.workflowEngine !== aggregate.workflowEngine) {
    return {
      ok: false,
      code: "stale_version",
      expected: `workflowEngine=${aggregate.activeCycle.workflowEngine} (from active cycle)`,
      actual: `workflowEngine=${aggregate.workflowEngine} (task-level)`,
    };
  }

  // 4. Active cycle check
  if (command.workflowCycleId) {
    if (aggregate.activeWorkflowCycleId !== command.workflowCycleId) {
      return {
        ok: false,
        code: "cycle_mismatch",
        expected: `cycle=${command.workflowCycleId}`,
        actual: `cycle=${aggregate.activeWorkflowCycleId ?? "null"}`,
      };
    }
  }

  // For start_implementation, verify no active cycle exists.
  if (command.intent === "start_implementation" && aggregate.activeWorkflowCycleId) {
    return {
      ok: false,
      code: "cycle_mismatch",
      expected: "no active cycle",
      actual: `cycle=${aggregate.activeWorkflowCycleId}`,
    };
  }

  // 4b. §10 fence recheck — project WIP (additive, PHASEE-03 Step 3)
  // A concurrent start_implementation on another task in the same project
  // by the same assignee may have committed between the guard pass and this
  // transaction. The pure guardProjectWIP checked the pre-transaction
  // snapshot; this recheck reads the authoritative state inside the tx.
  if (
    command.intent === "start_implementation" &&
    aggregate.otherInProgressTaskForAssignee
  ) {
    return {
      ok: false,
      code: "stale_version",
      expected: "no other In Progress task for assignee in project",
      actual: `In Progress task "${aggregate.otherInProgressTaskForAssignee.title}" found`,
    };
  }

  // 4c. §10 fence recheck — effective branch collision (additive, PHASEE-03 Step 3)
  // A concurrent start_implementation on another task resolving to the same
  // effective branch may have committed between the guard pass and this tx.
  if (
    command.intent === "start_implementation" &&
    aggregate.otherInProgressTaskOnBranch
  ) {
    return {
      ok: false,
      code: "stale_version",
      expected: "no other In Progress task on same effective branch",
      actual: `In Progress task "${aggregate.otherInProgressTaskOnBranch.title}" on branch ${aggregate.otherInProgressTaskOnBranch.branchName ?? "(none)"}`,
    };
  }

  // 4d. §10 fence recheck — unresolved prerequisites (additive, PHASEE-03 Step 3)
  // A dependency may have been un-Done (or a new prerequisite added) between
  // the guard pass and this transaction. The aggregate loader filters to
  // non-Done prerequisites, so any entry here is an unresolved one.
  if (
    command.intent === "start_implementation" &&
    aggregate.unresolvedPrerequisites.length > 0
  ) {
    const names = aggregate.unresolvedPrerequisites.map((d) => d.title).join(", ");
    return {
      ok: false,
      code: "stale_version",
      expected: "all prerequisites Done",
      actual: `unresolved: ${names}`,
    };
  }

  // 5. Lease status/identity check for review intents
  if (
    (command.intent === "accept_review" ||
      command.intent === "request_review_changes") &&
    aggregate.activeWorkflowCycleId
  ) {
    const lease = aggregate.activeReviewRun;

    if (!lease) {
      return {
        ok: false,
        code: "lease_mismatch",
        expected: "active review lease",
        actual: "no review lease for active cycle",
      };
    }

    const allowedLeaseStatuses = command.intent === "request_review_changes" || canRetryAcceptedRepositoryReview(aggregate)
      ? ["awaiting_review", "accepted", ...(command.intent === "request_review_changes" ? ["accepted_pending_owner"] : [])]
      : ["awaiting_review"];
    if (!allowedLeaseStatuses.includes(lease.status)) {
      return {
        ok: false,
        code: "lease_mismatch",
        expected: `lease status=${allowedLeaseStatuses.join(" or ")}`,
        actual: `lease status=${lease.status}`,
      };
    }

    if (command.intent === "accept_review" && lease.status === "accepted"
      && (command.payload.reviewRunId !== lease.id || command.payload.candidateSha !== lease.candidateSha)) {
      return {
        ok: false,
        code: "lease_mismatch",
        expected: `accepted lease ${lease.id} at ${lease.candidateSha}`,
        actual: `lease ${command.payload.reviewRunId} at ${command.payload.candidateSha}`,
      };
    }

    // 6. Candidate SHA check for accept_review
    if (
      command.intent === "accept_review" &&
      preTransactionState.activeReviewRun &&
      lease.candidateSha !== preTransactionState.activeReviewRun.candidateSha
    ) {
      return {
        ok: false,
        code: "candidate_mismatch",
        expected: `candidateSha=${preTransactionState.activeReviewRun.candidateSha}`,
        actual: `candidateSha=${lease.candidateSha}`,
      };
    }
  }

  // 7. Repository run phase check — a concurrent repository-run phase advance
  //    (e.g. validation completed between snapshot and transaction) must not
  //    pass the fence. Compare the phase recorded in the pre-transaction
  //    snapshot against the phase re-read inside the transaction.
  if (
    preTransactionState.repositoryRun &&
    aggregate.repositoryRun &&
    aggregate.repositoryRun.phase !== preTransactionState.repositoryRun.phase
  ) {
    return {
      ok: false,
      code: "stale_version",
      expected: `repositoryRun phase=${preTransactionState.repositoryRun.phase}`,
      actual: `repositoryRun phase=${aggregate.repositoryRun.phase}`,
    };
  }

  // 8. Action Plan revision check (when the command depends on plan approval)
  if (
    command.intent === "start_implementation" ||
    command.intent === "checkpoint" ||
    command.intent === "submit_for_review"
  ) {
    if (!aggregate.approvedOn) {
      return {
        ok: false,
        code: "stale_version",
        expected: "approved plan",
        actual: "plan not approved",
      };
    }

    if (preTransactionState.approvedOn && aggregate.approvedOn) {
      // Check that the approval didn't change (different approval timestamp
      // means a different plan revision was approved).
      if (aggregate.approvedOn.getTime() !== preTransactionState.approvedOn.getTime()) {
        return {
          ok: false,
          code: "stale_version",
          expected: `approvedOn=${preTransactionState.approvedOn.toISOString()}`,
          actual: `approvedOn=${aggregate.approvedOn.toISOString()}`,
        };
      }
    }
  }

  // 9. Active-procedure uniqueness check
  // For intents that start a procedure, verify no duplicate active procedure
  // of the same type exists for this cycle. The decision function declares
  // the procedureType; we check it here in the transaction.
  if (aggregate.activeWorkflowCycleId) {
    const activeProcedures = await tx.taskProcedureRun.findMany({
      where: {
        taskId: taskId,
        workflowCycleId: aggregate.activeWorkflowCycleId,
        status: { in: ["queued", "running"] },
      },
      select: { id: true, type: true },
    });

    // For intents that open a new procedure, check that a conflicting one
    // doesn't already exist. The execute.ts upsert logic handles reuse,
    // but the fence prevents a race where two commands try to start the
    // same procedure type simultaneously.
    const procedureTypeMap: Record<string, string> = {
      start_implementation: "start_implementation_cycle",
      submit_for_review: "submit_candidate_for_review",
      request_review_changes: "return_review_for_changes",
      accept_review: "finalize_accepted_review",
      approve_plan: "prepare_todo_task",
    };

    const expectedProcedureType = procedureTypeMap[command.intent];
    if (expectedProcedureType) {
      const conflicting = activeProcedures.filter(
        (p) => p.type === expectedProcedureType,
      );
      // One existing procedure is fine (execute.ts will reuse it). Two or
      // more means a race produced duplicates — that's an invariant violation.
      if (conflicting.length > 1) {
        return {
          ok: false,
          code: "idempotency_conflict",
          expected: `at most one active ${expectedProcedureType} procedure`,
          actual: `${conflicting.length} active ${expectedProcedureType} procedures`,
        };
      }
    }
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// mapFenceResultToOrchestratorResult — converts a failed FenceResult into
// an OrchestratorResult using existing error/message fields. No
// domainErrorCode field is added to OrchestratorResult (that belongs to 02a).
// The error code is embedded in the reason string so callers can inspect it.
// ---------------------------------------------------------------------------

export function mapFenceResultToOrchestratorResult(
  fence: FenceResult,
): { status: "stale" | "invalid"; reason: string; domainCode: FenceErrorCode } {
  if (fence.ok) {
    throw new Error("mapFenceResultToOrchestratorResult called with ok result");
  }
  const reason = `[${fence.code}] expected ${fence.expected}, found ${fence.actual}`;
  // cycle_mismatch and lease_mismatch are stale states; candidate_mismatch
  // and stale_version are also stale. idempotency_conflict is invalid.
  if (fence.code === "idempotency_conflict") {
    return { status: "invalid", reason, domainCode: fence.code };
  }
  return { status: "stale", reason, domainCode: fence.code };
}
