import { recordLegacyWorkflowBoundaryInvocation } from "@/lib/tasks/legacy-workflow-boundary";
import { db } from "@/lib/db";
import { fenceSupersededPmChannelRuns } from "@/lib/agents/pm-channel/supersession";
import { writeTaskExecutionState } from "@/lib/agents/watchdog/state";
import { detectPhaseEInvariants, type PhaseEInvariantFinding } from "@/lib/tasks/orchestrator/phase-e-invariants";

const DEFAULT_STALE_MS = 10 * 60_000;
const DEFAULT_LIMIT = 100;

export type WorkflowReconciliationKind =
  | "outbox_delivery_stale"
  | "outbox_delivery_failed"
  | "repository_effect_missing"
  | "repository_projection_stale"
  | "review_handoff_missing"
  | "review_lease_missing"
  | "review_completion_missing"
  | "done_repository_incomplete"
  | "cancellation_unacknowledged"
  // ORCH-08 procedure-aware detectors
  | "in_progress_no_open_cycle"
  | "review_no_active_cycle"
  | "review_no_lease"
  | "accepted_review_no_finalization_procedure"
  | "finalization_completed_no_done_transition"
  | "multiple_open_cycles"
  | "procedure_step_waiting_on_terminal_job"
  | "done_cycle_incomplete"
  // PHASEE-10 invariant detectors
  | "engine_ownership_mismatch"
  | "stale_receipt_without_transition"
  | "procedure_run_without_cycle"
  | "dual_engine_active"
  | "unknown_engine_value";

export type WorkflowReconciliationFinding = {
  kind: WorkflowReconciliationKind;
  taskId: string | null;
  rowId: string;
  detail: string;
  repair: "drain" | "requeue" | "retry_cancellation" | "escalate";
  repaired: boolean;
  error: string | null;
};

export type WorkflowReconciliationReport = {
  now: string;
  dryRun: boolean;
  inspectedTasks: number;
  findings: WorkflowReconciliationFinding[];
  repaired: number;
  escalated: number;
  errors: string[];
  metrics: {
    outboxByStatus: Record<string, number>;
    repositoryByPhase: Record<string, number>;
    executionByState: Record<string, number>;
    cancellationPending: number;
    // ORCH-08 procedure-aware metrics
    cyclesByStatus: Record<string, number>;
    proceduresByStatus: Record<string, number>;
    procedureStepsByStatus: Record<string, number>;
  };
};

function staleMs() {
  const parsed = Number.parseInt(process.env.PM_WORKFLOW_RECONCILE_STALE_MS ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 60_000 ? parsed : DEFAULT_STALE_MS;
}

function errorText(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).trim().slice(0, 2_000);
}

function verifiedEpicMerge(args: {
  taskId: string;
  epicId: string | null;
  candidateSha: string;
  activity: Array<{ payload: string | null }>;
}) {
  if (!args.epicId) return false;
  return args.activity.some((row) => {
    if (!row.payload) return false;
    try {
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      return payload.taskId === args.taskId
        && payload.epicId === args.epicId
        && payload.candidateSha === args.candidateSha;
    } catch {
      return false;
    }
  });
}

async function escalateTask(args: {
  taskId: string;
  projectId: string;
  kind: WorkflowReconciliationKind;
  detail: string;
  rowId: string;
  now: Date;
}) {
  await writeTaskExecutionState({
    taskId: args.taskId,
    projectId: args.projectId,
    state: "stalled",
    reasonCode: args.kind,
    reasonDetail: args.detail,
    recoveryAction: "escalated to reporter",
    recoveryAt: undefined,
    detectorId: `workflow_reconciler:${args.kind}`,
  });
  const alreadyLogged = await db.activityLog.findFirst({
    where: {
      taskId: args.taskId,
      kind: "task.workflow.reconciliation_required",
      payload: { contains: `\"rowId\":\"${args.rowId}\"` },
    },
    select: { id: true },
  });
  if (!alreadyLogged) {
    await db.activityLog.create({
      data: {
        projectId: args.projectId,
        taskId: args.taskId,
        kind: "task.workflow.reconciliation_required",
        payload: JSON.stringify({ kind: args.kind, rowId: args.rowId, detail: args.detail }),
      },
    });
  }
}

/**
 * Reconcile durable workflow decisions with their asynchronous projections.
 * Safe repairs only: reclaim/requeue a recorded effect or retry a recorded
 * cancellation fence. Missing evidence is escalated, never guessed.
 */
export async function runWorkflowReconciliation(options: {
  projectId?: string;
  now?: Date;
  dryRun?: boolean;
  limit?: number;
} = {}): Promise<WorkflowReconciliationReport> {
  await recordLegacyWorkflowBoundaryInvocation({
    legacyBoundary: "workflow-reconciler-and-repair-tools",
    entryPoint: "runWorkflowReconciliation",
  });
  const now = options.now ?? new Date();
  const staleBefore = new Date(now.getTime() - staleMs());
  const limit = Math.max(1, Math.min(500, options.limit ?? DEFAULT_LIMIT));
  const dryRun = options.dryRun ?? false;
  const findings: WorkflowReconciliationFinding[] = [];
  const errors: string[] = [];
  let repaired = 0;
  let escalated = 0;

  const tasks = await db.task.findMany({
    where: {
      deletedAt: null,
      ...(options.projectId ? { projectId: options.projectId } : {}),
      OR: [
        { status: { in: ["Review", "Done"] } },
        { status: { in: ["In Progress", "To Do"] } },
        { repositoryRun: { is: { phase: { in: ["validating", "review_ready", "finalizing"] } } } },
        { workflowOutbox: { some: { status: { in: ["queued", "dispatching", "failed"] } } } },
        { activeWorkflowCycleId: { not: null } },
        { workflowCycles: { some: { status: "open" } } },
        { procedureRuns: { some: { status: { in: ["queued", "running", "operational_error"] } } } },
      ],
    },
    take: limit,
    select: {
      id: true,
      projectId: true,
      epicId: true,
      status: true,
      workflowVersion: true,
      activeWorkflowCycleId: true,
      workflowEngine: true,
      workflowEnginePinnedAt: true,
      repositoryRun: {
        select: {
          id: true,
          phase: true,
          repoTouched: true,
          candidateSha: true,
          reviewedSha: true,
          validationOutcome: true,
          updatedAt: true,
        },
      },
      reviewRuns: {
        where: { status: { in: ["validating", "awaiting_review", "accepted"] } },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          status: true,
          candidateSha: true,
          reviewerId: true,
          reviewedAt: true,
          updatedAt: true,
        },
      },
      activity: {
        where: { kind: "pm.epic.merge.ok" },
        orderBy: { createdAt: "desc" },
        take: 20,
        select: { payload: true },
      },
      workflowOutbox: {
        orderBy: { updatedAt: "desc" },
        select: {
          id: true,
          effectType: true,
          status: true,
          availableAt: true,
          leaseExpiresAt: true,
          updatedAt: true,
          lastError: true,
        },
      },
      workflowCycles: {
        where: { status: "open" },
        select: { id: true, sequence: true, status: true, outcome: true, workflowEngine: true },
      },
      procedureRuns: {
        where: { status: { in: ["queued", "running", "operational_error"] } },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          type: true,
          status: true,
          currentStep: true,
          lastError: true,
          workflowCycleId: true,
          steps: {
            where: { status: "waiting_callback" },
            select: { id: true, name: true, status: true, output: true, availableAt: true },
          },
        },
      },
      commandReceipts: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: {
          idempotencyKey: true,
          intent: true,
          status: true,
          transitionId: true,
          createdAt: true,
        },
      },
    },
  });

  const findingKeys = new Set<string>();
  const add = (finding: WorkflowReconciliationFinding) => {
    const key = `${finding.kind}:${finding.rowId}`;
    if (findingKeys.has(key)) return;
    findingKeys.add(key);
    findings.push(finding);
  };

  for (const task of tasks) {
    for (const effect of task.workflowOutbox) {
      const queuedStale = effect.status === "queued"
        && effect.availableAt.getTime() <= now.getTime()
        && effect.updatedAt.getTime() <= staleBefore.getTime();
      const leaseExpired = effect.status === "dispatching"
        && Boolean(effect.leaseExpiresAt && effect.leaseExpiresAt.getTime() <= now.getTime());
      if (queuedStale || leaseExpired) {
        add({
          kind: "outbox_delivery_stale",
          taskId: task.id,
          rowId: effect.id,
          detail: leaseExpired
            ? `${effect.effectType} dispatcher lease expired before completion`
            : `${effect.effectType} remained queued beyond the reconciliation grace period`,
          repair: "drain",
          repaired: false,
          error: null,
        });
      } else if (effect.status === "failed") {
        add({
          kind: "outbox_delivery_failed",
          taskId: task.id,
          rowId: effect.id,
          detail: `${effect.effectType} exhausted its delivery attempts${effect.lastError ? `: ${effect.lastError}` : ""}`,
          repair: "escalate",
          repaired: false,
          error: null,
        });
      }
    }

    const repository = task.repositoryRun;
    if (repository && repository.updatedAt.getTime() <= staleBefore.getTime()
      && (repository.phase === "validating" || repository.phase === "finalizing")) {
      const effectType = repository.phase === "validating" ? "branch_verify" : "review_finalize";
      const effect = task.workflowOutbox.find((row) => row.effectType === effectType);
      if (!effect) {
        add({
          kind: "repository_effect_missing",
          taskId: task.id,
          rowId: repository.id,
          detail: `${repository.phase} repository state has no durable ${effectType} effect to execute`,
          repair: "escalate",
          repaired: false,
          error: null,
        });
      } else if (effect.status === "completed" && effect.updatedAt.getTime() <= staleBefore.getTime()) {
        add({
          kind: "repository_projection_stale",
          taskId: task.id,
          rowId: effect.id,
          detail: `${effectType} was projected, but repository state remained ${repository.phase}`,
          repair: "requeue",
          repaired: false,
          error: null,
        });
      }
    }

    // A successful verifier projection must leave In Progress. If it does
    // not, replay the already-recorded branch verification effect so the
    // current worktree/candidate is checked again before PM retries the
    // handoff. This is safer than inventing a Review transition from stale
    // repository metadata and catches candidate-key replay bugs like V23-36.
    if (
      task.status === "In Progress"
      && repository?.phase === "review_ready"
      && repository.updatedAt.getTime() <= staleBefore.getTime()
      && Boolean(repository.candidateSha)
      && (repository.validationOutcome === "valid" || repository.validationOutcome === "valid_with_warning")
    ) {
      const verifyEffect = task.workflowOutbox.find((row) => row.effectType === "branch_verify");
      // A recently queued/dispatched/completed verifier may still be
      // projecting its result. Observe the normal stale grace before taking
      // another action; only a missing effect is immediately irrecoverable.
      if (!verifyEffect || (
        verifyEffect.status === "completed"
        && verifyEffect.updatedAt.getTime() <= staleBefore.getTime()
      )) {
        add({
          kind: "review_handoff_missing",
          taskId: task.id,
          rowId: verifyEffect?.id ?? repository.id,
          detail: "repository validation passed, but the task remained In Progress instead of entering Review",
          repair: verifyEffect ? "requeue" : "escalate",
          repaired: false,
          error: null,
        });
      }
    }

    if (task.status === "Review" && repository?.phase === "review_ready") {
      const awaiting = task.reviewRuns.some((run) => run.status === "awaiting_review");
      if (!awaiting) {
        add({
          kind: "review_lease_missing",
          taskId: task.id,
          rowId: repository.id,
          detail: "task is in Review with a review-ready repository candidate but no active ReviewRun lease",
          repair: "escalate",
          repaired: false,
          error: null,
        });
      }
    }
    if (
      task.status === "Review"
      && repository?.phase === "completed"
      && repository.updatedAt.getTime() <= staleBefore.getTime()
      && repository.repoTouched === true
      && repository.candidateSha
      && repository.reviewedSha === repository.candidateSha
      && (repository.validationOutcome === "valid" || repository.validationOutcome === "valid_with_warning")
    ) {
      const acceptedReview = task.reviewRuns.some((run) =>
        run.status === "accepted"
        && run.candidateSha === repository.candidateSha
        && Boolean(run.reviewerId)
        && Boolean(run.reviewedAt),
      );
      if (acceptedReview && verifiedEpicMerge({
        taskId: task.id,
        epicId: task.epicId,
        candidateSha: repository.candidateSha,
        activity: task.activity,
      })) {
        add({
          kind: "review_completion_missing",
          taskId: task.id,
          rowId: repository.id,
          detail: "review was accepted and the validated candidate was merged, but the audited Review-to-Done transition is missing",
          // Reconciliation reports the contradiction but never fabricates a
          // review/finalization decision. An operator must submit the exact
          // typed repair command using the recorded lease/callback evidence.
          repair: "escalate",
          repaired: false,
          error: null,
        });
      }
    }
    if (task.status === "Done" && repository && repository.phase !== "completed") {
      add({
        kind: "done_repository_incomplete",
        taskId: task.id,
        rowId: repository.id,
        detail: `task is Done while its repository lifecycle is ${repository.phase}, not completed`,
        repair: "escalate",
        repaired: false,
        error: null,
      });
    }

    // --- ORCH-08 procedure-aware detectors -------------------------------
    // In Progress with no open cycle (invariant 5: one open cycle per task).
    if (task.status === "In Progress" && task.activeWorkflowCycleId === null && task.workflowCycles.length === 0) {
      add({
        kind: "in_progress_no_open_cycle",
        taskId: task.id,
        rowId: task.id,
        detail: "task is In Progress with no open workflow cycle",
        repair: "escalate",
        repaired: false,
        error: null,
      });
    }

    // More than one open cycle (invariant 5).
    if (task.workflowCycles.length > 1) {
      add({
        kind: "multiple_open_cycles",
        taskId: task.id,
        rowId: task.workflowCycles[0].id,
        detail: `task has ${task.workflowCycles.length} open workflow cycles (invariant: at most one)`,
        repair: "escalate",
        repaired: false,
        error: null,
      });
    }

    // Review with no active cycle.
    if (task.status === "Review" && task.activeWorkflowCycleId === null) {
      add({
        kind: "review_no_active_cycle",
        taskId: task.id,
        rowId: task.id,
        detail: "task is in Review with no active workflow cycle",
        repair: "escalate",
        repaired: false,
        error: null,
      });
    }

    // Review with no immutable review lease.
    if (task.status === "Review" && repository?.phase === "review_ready") {
      const awaiting = task.reviewRuns.some((run) => run.status === "awaiting_review" || run.status === "accepted");
      if (!awaiting) {
        add({
          kind: "review_no_lease",
          taskId: task.id,
          rowId: repository.id,
          detail: "task is in Review with a review-ready repository but no active or accepted review lease",
          repair: "escalate",
          repaired: false,
          error: null,
        });
      }
    }

    // Accepted review with no finalization procedure.
    if (task.status === "Review" && task.reviewRuns.some((run) => run.status === "accepted")) {
      const hasFinalizationProc = task.procedureRuns.some((p) => p.type === "finalize_accepted_review");
      if (!hasFinalizationProc) {
        add({
          kind: "accepted_review_no_finalization_procedure",
          taskId: task.id,
          rowId: task.id,
          detail: "review was accepted but no finalization procedure is running",
          repair: "escalate",
          repaired: false,
          error: null,
        });
      }
    }

    // Finalization completed (repository phase) but task still in Review.
    // Escalate (do not auto-complete) — the existing review_completion_missing
    // detector reports the evidence-gated contradiction for an explicit
    // operator command; the reconciler never completes the review itself.
    if (
      task.status === "Review" &&
      repository?.phase === "completed" &&
      repository.updatedAt.getTime() <= staleBefore.getTime() &&
      task.reviewRuns.some((run) => run.status === "accepted")
    ) {
      // Only fire if the existing review_completion_missing detector did NOT
      // fire (i.e. no verified Epic merge evidence). The existing detector
      // handles the safe auto-complete; this one just escalates.
      const hasMergeEvidence = verifiedEpicMerge({
        taskId: task.id,
        epicId: task.epicId,
        candidateSha: repository.candidateSha ?? "",
        activity: task.activity,
      });
      if (!hasMergeEvidence) {
        add({
          kind: "finalization_completed_no_done_transition",
          taskId: task.id,
          rowId: repository.id,
          detail: "repository finalization completed but the Review-to-Done transition is missing and no Epic merge evidence was found",
          repair: "escalate",
          repaired: false,
          error: null,
        });
      }
    }

    // Done while cycle/review state is incomplete.
    if (task.status === "Done") {
      const openCycles = task.workflowCycles.length;
      const acceptedLeases = task.reviewRuns.filter((r) => r.status === "accepted" || r.status === "completed");
      if (openCycles > 0 || acceptedLeases.length === 0) {
        add({
          kind: "done_cycle_incomplete",
          taskId: task.id,
          rowId: task.id,
          detail: openCycles > 0
            ? `task is Done with ${openCycles} open cycle(s)`
            : "task is Done with no accepted/completed review lease",
          repair: "escalate",
          repaired: false,
          error: null,
        });
      }
    }

    // Procedure step waiting on a missing/terminal job.
    for (const proc of task.procedureRuns) {
      for (const step of proc.steps) {
        if (step.status === "waiting_callback" && step.availableAt.getTime() <= staleBefore.getTime()) {
          add({
            kind: "procedure_step_waiting_on_terminal_job",
            taskId: task.id,
            rowId: step.id,
            detail: `procedure step ${proc.type}:${step.name} is waiting for a callback that has not arrived within the grace period`,
            repair: "escalate",
            repaired: false,
            error: null,
          });
        }
      }
    }

    // --- PHASEE-10 invariant detectors -----------------------------------
    // Read the open cycle's engine from the cycle row itself (not the task
    // field) so detectEngineOwnershipMismatch compares two independent values.
    const openCycle = task.workflowCycles.find((c) => c.status === "open") ?? null;
    const lastReceipt = task.commandReceipts.length > 0 ? task.commandReceipts[0] : null;
    const phaseEFindings = detectPhaseEInvariants({
      taskId: task.id,
      taskEngine: task.workflowEngine,
      taskEnginePinnedAt: task.workflowEnginePinnedAt,
      activeCycle: openCycle
        ? { id: openCycle.id, workflowEngine: openCycle.workflowEngine, status: task.status }
        : null,
      lastReceipt: lastReceipt
        ? {
            idempotencyKey: lastReceipt.idempotencyKey,
            intent: lastReceipt.intent,
            status: lastReceipt.status,
            transitionId: lastReceipt.transitionId,
            createdAt: lastReceipt.createdAt,
          }
        : null,
      activeProcedureRuns: task.procedureRuns.map((p) => ({
        id: p.id,
        type: p.type,
        workflowCycleId: p.workflowCycleId,
      })),
      taskStatus: task.status,
    });
    for (const finding of phaseEFindings) {
      add({
        kind: finding.kind as WorkflowReconciliationKind,
        taskId: finding.taskId,
        rowId: finding.taskId,
        detail: finding.detail,
        repair: finding.repair,
        repaired: false,
        error: null,
      });
    }
  }

  const cancellationRows = await db.pmChannelRun.findMany({
    where: {
      cancellationRequestedAt: { lte: staleBefore },
      cancellationAcknowledgedAt: null,
      supersededByRunId: { not: null },
      ...(options.projectId ? { projectId: options.projectId } : {}),
    },
    take: Math.min(limit, 20),
    select: { id: true, taskId: true, projectId: true, supersededByRunId: true, cancellationError: true },
  });
  for (const row of cancellationRows) {
    add({
      kind: "cancellation_unacknowledged",
      taskId: row.taskId,
      rowId: row.id,
      detail: row.cancellationError
        ? `superseded process cancellation is not fenced: ${row.cancellationError}`
        : "superseded process cancellation was requested but never acknowledged",
      repair: "retry_cancellation",
      repaired: false,
      error: null,
    });
  }

  const [outboxGroups, repositoryGroups, executionGroups, cancellationPending, cycleGroups, procedureGroups, procedureStepGroups] = await Promise.all([
    db.workflowOutbox.groupBy({
      by: ["status"],
      where: options.projectId ? { projectId: options.projectId } : undefined,
      _count: { _all: true },
    }),
    db.taskRepositoryRun.groupBy({
      by: ["phase"],
      where: options.projectId ? { task: { projectId: options.projectId } } : undefined,
      _count: { _all: true },
    }),
    db.taskExecutionState.groupBy({
      by: ["state"],
      where: options.projectId ? { projectId: options.projectId } : undefined,
      _count: { _all: true },
    }),
    db.pmChannelRun.count({
      where: {
        cancellationRequestedAt: { not: null },
        cancellationAcknowledgedAt: null,
        ...(options.projectId ? { projectId: options.projectId } : {}),
      },
    }),
    // ORCH-08 procedure-aware metrics
    db.taskWorkflowCycle.groupBy({
      by: ["status"],
      _count: { _all: true },
    }),
    db.taskProcedureRun.groupBy({
      by: ["status"],
      _count: { _all: true },
    }),
    db.taskProcedureStep.groupBy({
      by: ["status"],
      _count: { _all: true },
    }),
  ]);

  if (!dryRun) {
    const escalatedTasks = new Set<string>();
    for (const finding of findings) {
      try {
        if (finding.repair === "requeue") {
          const changed = await db.workflowOutbox.updateMany({
            where: { id: finding.rowId, status: "completed", updatedAt: { lte: staleBefore } },
            data: {
              status: "queued",
              attempts: 0,
              availableAt: now,
              leaseOwner: null,
              leaseExpiresAt: null,
              completedAt: null,
              lastError: "Requeued by workflow reconciler after stale downstream state.",
            },
          });
          finding.repaired = changed.count === 1;
        } else if (finding.repair === "drain") {
          // The generic outbox drain immediately follows this pass in the PM
          // worker. Expired leases are claimable without rewriting them here.
          finding.repaired = true;
        } else if (finding.repair === "retry_cancellation") {
          const row = cancellationRows.find((candidate) => candidate.id === finding.rowId);
          if (!row?.supersededByRunId) continue;
          const result = await fenceSupersededPmChannelRuns({ replacementRunId: row.supersededByRunId });
          finding.repaired = result.ok;
          if (!result.ok) finding.error = result.error;
        } else if (finding.taskId) {
          if (escalatedTasks.has(finding.taskId)) {
            finding.repaired = true;
            continue;
          }
          const task = tasks.find((candidate) => candidate.id === finding.taskId);
          if (!task) continue;
          await escalateTask({
            taskId: task.id,
            projectId: task.projectId,
            kind: finding.kind,
            detail: finding.detail,
            rowId: finding.rowId,
            now,
          });
          finding.repaired = true;
          escalatedTasks.add(finding.taskId);
          escalated += 1;
        }
        if (finding.repaired) repaired += 1;
      } catch (error) {
        finding.error = errorText(error);
        errors.push(`${finding.kind}/${finding.rowId}: ${finding.error}`);
      }
    }
  }

  return {
    now: now.toISOString(),
    dryRun,
    inspectedTasks: tasks.length,
    findings,
    repaired,
    escalated,
    errors,
    metrics: {
      outboxByStatus: Object.fromEntries(outboxGroups.map((row) => [row.status, row._count._all])),
      repositoryByPhase: Object.fromEntries(repositoryGroups.map((row) => [row.phase, row._count._all])),
      executionByState: Object.fromEntries(executionGroups.map((row) => [row.state, row._count._all])),
      cancellationPending,
      cyclesByStatus: Object.fromEntries(cycleGroups.map((row) => [row.status, row._count._all])),
      proceduresByStatus: Object.fromEntries(procedureGroups.map((row) => [row.status, row._count._all])),
      procedureStepsByStatus: Object.fromEntries(procedureStepGroups.map((row) => [row.status, row._count._all])),
    },
  };
}
